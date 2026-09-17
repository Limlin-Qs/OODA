import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { appendAudit } from '../audit/store.js'
import { transitionBorrow, type BorrowStatus } from '../domain/rules.js'

export interface Borrow {
  id: string
  deviceId: string
  borrowerMemberId: string
  status: BorrowStatus
  borrowedAt: Date
  dueAt: Date
  returnedAt: Date | null
  returnNotes: string
}

export type BorrowErrorCode =
  | 'conflict'
  | 'forbidden'
  | 'idempotency_conflict'
  | 'invalid_due_at'
  | 'invalid_state'
  | 'not_found'

export class BorrowError extends Error {
  public readonly code: BorrowErrorCode

  constructor(code: BorrowErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'BorrowError'
  }
}

interface BorrowRow {
  id: string
  device_id: string
  borrower_member_id: string
  status: BorrowStatus
  borrowed_at: Date
  due_at: Date
  returned_at: Date | null
  return_notes: string
}

interface IdempotencyRow {
  request_hash: string
  result_json: Borrow
}

function toBorrow(row: BorrowRow): Borrow {
  return {
    id: row.id,
    deviceId: row.device_id,
    borrowerMemberId: row.borrower_member_id,
    status: row.status,
    borrowedAt: row.borrowed_at,
    dueAt: row.due_at,
    returnedAt: row.returned_at,
    returnNotes: row.return_notes,
  }
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`)
    .join(',')}}`
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(stableValue(value)).digest('hex')
}

async function acquireIdempotencyLock(
  client: PoolClient,
  actorMemberId: string,
  operation: string,
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  const lockKey = `${actorMemberId}:${operation}:${idempotencyKey}`
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])
  const result = await client.query<IdempotencyRow>(
    `SELECT request_hash, result_json
     FROM idempotency_keys
     WHERE actor_member_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [actorMemberId, operation, idempotencyKey],
  )
  return result.rows[0] ?? null
}

function replayOrThrow(
  existing: IdempotencyRow | null,
  requestHash: string,
): Borrow | null {
  if (!existing) return null
  if (existing.request_hash !== requestHash) {
    throw new BorrowError(
      'idempotency_conflict',
      'The idempotency key was already used with different request data.',
    )
  }
  return existing.result_json
}

async function insertIdempotencyResult(
  client: PoolClient,
  actorMemberId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  record: Borrow,
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys
      (actor_member_id, operation, idempotency_key, request_hash, resource_id, result_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      actorMemberId,
      operation,
      idempotencyKey,
      requestHash,
      record.id,
      JSON.stringify(record),
    ],
  )
}

const borrowColumns = `
  id, device_id, borrower_member_id, status, borrowed_at, due_at, returned_at, return_notes
`

export async function findBorrow(
  client: PoolClient,
  id: string,
): Promise<Borrow | null> {
  const result = await client.query<BorrowRow>(
    `SELECT ${borrowColumns} FROM borrow_records WHERE id = $1`,
    [id],
  )
  return result.rows[0] ? toBorrow(result.rows[0]) : null
}

export async function listBorrows(
  client: PoolClient,
  memberId: string,
  isAdmin: boolean,
): Promise<Borrow[]> {
  const result = await client.query<BorrowRow>(
    `SELECT ${borrowColumns} FROM borrow_records
     WHERE $2 OR borrower_member_id = $1
     ORDER BY borrowed_at DESC, id DESC`,
    [memberId, isAdmin],
  )
  return result.rows.map(toBorrow)
}

export async function borrowDevice(
  client: PoolClient,
  actorMemberId: string,
  borrowerMemberId: string,
  deviceId: string,
  dueAt: Date,
  idempotencyKey: string,
  requestHash: string,
  reason = '',
): Promise<{ record: Borrow; replayed: boolean }> {
  const existing = await acquireIdempotencyLock(
    client,
    actorMemberId,
    'borrow',
    idempotencyKey,
  )
  const replay = replayOrThrow(existing, requestHash)
  if (replay) return { record: replay, replayed: true }

  const nowResult = await client.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now')
  const borrowedAt = nowResult.rows[0].now
  if (dueAt.getTime() <= borrowedAt.getTime()) {
    throw new BorrowError('invalid_due_at', 'The due time must be in the future.')
  }

  const deviceResult = await client.query<{ status: string }>(
    'SELECT status FROM devices WHERE id = $1 FOR UPDATE',
    [deviceId],
  )
  const device = deviceResult.rows[0]
  if (!device) throw new BorrowError('not_found', 'The device was not found.')
  if (device.status !== 'available') {
    throw new BorrowError('conflict', 'The device is not available.')
  }

  const reservationResult = await client.query<{ id: string }>(
    `SELECT id FROM reservations
     WHERE device_id = $1 AND status = 'active'
       AND start_at < $3 AND end_at > $2
     FOR UPDATE`,
    [deviceId, borrowedAt, dueAt],
  )
  if (reservationResult.rowCount !== 0) {
    throw new BorrowError('conflict', 'The device has an active reservation.')
  }

  const activeResult = await client.query<{ id: string }>(
    `SELECT id FROM borrow_records
     WHERE device_id = $1 AND status = 'active' FOR UPDATE`,
    [deviceId],
  )
  if (activeResult.rowCount !== 0) {
    throw new BorrowError('conflict', 'The device is already borrowed.')
  }

  const result = await client.query<BorrowRow>(
    `INSERT INTO borrow_records
      (id, device_id, borrower_member_id, status, borrowed_at, due_at)
     VALUES ($1, $2, $3, 'active', $4, $5)
     RETURNING ${borrowColumns}`,
    [randomUUID(), deviceId, borrowerMemberId, borrowedAt, dueAt],
  )
  const record = toBorrow(result.rows[0])
  await appendAudit(client, {
    entityType: 'borrow',
    entityId: record.id,
    action: 'borrow.created',
    actorMemberId,
    subjectMemberId: borrowerMemberId,
    reason,
    afterState: { status: record.status, deviceId: record.deviceId },
    result: 'success',
  })
  await insertIdempotencyResult(
    client,
    actorMemberId,
    'borrow',
    idempotencyKey,
    requestHash,
    record,
  )
  return { record, replayed: false }
}

export async function returnBorrow(
  client: PoolClient,
  actorMemberId: string,
  isAdmin: boolean,
  borrowId: string,
  returnNotes: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ record: Borrow; replayed: boolean }> {
  const existing = await acquireIdempotencyLock(
    client,
    actorMemberId,
    'return',
    idempotencyKey,
  )
  const replay = replayOrThrow(existing, requestHash)
  if (replay) return { record: replay, replayed: true }

  const result = await client.query<BorrowRow>(
    `SELECT ${borrowColumns} FROM borrow_records WHERE id = $1 FOR UPDATE`,
    [borrowId],
  )
  const current = result.rows[0]
  if (!current) throw new BorrowError('not_found', 'The borrow record was not found.')
  if (!isAdmin && current.borrower_member_id !== actorMemberId) {
    throw new BorrowError('forbidden', 'A member can only return their own borrow.')
  }
  if (current.status !== 'active') {
    throw new BorrowError('invalid_state', 'The borrow record is already returned.')
  }

  const returnedAtResult = await client.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now')
  const returnedAt = returnedAtResult.rows[0].now
  transitionBorrow(current.status, 'returned')
  const updated = await client.query<BorrowRow>(
    `UPDATE borrow_records
     SET status = 'returned', returned_at = $2, return_notes = $3
     WHERE id = $1
     RETURNING ${borrowColumns}`,
    [borrowId, returnedAt, returnNotes],
  )
  const record = toBorrow(updated.rows[0])
  await appendAudit(client, {
    entityType: 'borrow',
    entityId: record.id,
    action: 'borrow.returned',
    actorMemberId,
    subjectMemberId: record.borrowerMemberId,
    afterState: { status: record.status, returnedAt: record.returnedAt },
    result: 'success',
  })
  await insertIdempotencyResult(
    client,
    actorMemberId,
    'return',
    idempotencyKey,
    requestHash,
    record,
  )
  return { record, replayed: false }
}
