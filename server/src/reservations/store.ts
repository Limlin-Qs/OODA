import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { appendAudit } from '../audit/store.js'
import { hashRequest } from '../borrows/store.js'
import type { ReservationStatus } from '../domain/rules.js'

export interface Reservation {
  id: string
  deviceId: string
  reserverMemberId: string
  status: ReservationStatus
  startAt: Date
  endAt: Date
  cancelledAt: Date | null
}

export type ReservationErrorCode =
  | 'conflict'
  | 'forbidden'
  | 'idempotency_conflict'
  | 'invalid_interval'
  | 'invalid_state'
  | 'not_found'

export class ReservationError extends Error {
  public readonly code: ReservationErrorCode

  constructor(code: ReservationErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ReservationError'
  }
}

interface ReservationRow {
  id: string
  device_id: string
  reserver_member_id: string
  status: ReservationStatus
  start_at: Date
  end_at: Date
  cancelled_at: Date | null
}

interface IdempotencyRow {
  request_hash: string
  result_json: Reservation
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    deviceId: row.device_id,
    reserverMemberId: row.reserver_member_id,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    cancelledAt: row.cancelled_at,
  }
}

const reservationColumns = `
  id, device_id, reserver_member_id, status, start_at, end_at, cancelled_at
`

async function findIdempotency(
  client: PoolClient,
  actorMemberId: string,
  operation: string,
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `${actorMemberId}:${operation}:${idempotencyKey}`,
  ])
  const result = await client.query<IdempotencyRow>(
    `SELECT request_hash, result_json FROM idempotency_keys
     WHERE actor_member_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [actorMemberId, operation, idempotencyKey],
  )
  return result.rows[0] ?? null
}

function replayOrThrow(
  existing: IdempotencyRow | null,
  requestHash: string,
): Reservation | null {
  if (!existing) return null
  if (existing.request_hash !== requestHash) {
    throw new ReservationError(
      'idempotency_conflict',
      'The idempotency key was already used with different request data.',
    )
  }
  return existing.result_json
}

async function saveIdempotency(
  client: PoolClient,
  actorMemberId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  record: Reservation,
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

export async function listReservations(
  client: PoolClient,
  memberId: string,
  isAdmin: boolean,
): Promise<Reservation[]> {
  const result = await client.query<ReservationRow>(
    `SELECT ${reservationColumns} FROM reservations
     WHERE $2 OR reserver_member_id = $1
     ORDER BY start_at, id`,
    [memberId, isAdmin],
  )
  return result.rows.map(toReservation)
}

export async function findReservation(
  client: PoolClient,
  id: string,
): Promise<Reservation | null> {
  const result = await client.query<ReservationRow>(
    `SELECT ${reservationColumns} FROM reservations WHERE id = $1`,
    [id],
  )
  return result.rows[0] ? toReservation(result.rows[0]) : null
}

export interface Availability {
  available: boolean
  deviceStatus: string
  activeBorrowId: string | null
  reservations: Reservation[]
}

export async function getAvailability(
  client: PoolClient,
  deviceId: string,
  from?: Date,
  to?: Date,
): Promise<Availability> {
  const now = (await client.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now')).rows[0].now
  const rangeStart = from ?? now
  const rangeEnd = to ?? new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
  if (rangeStart.getTime() >= rangeEnd.getTime()) {
    throw new ReservationError('invalid_interval', 'Availability range is invalid.')
  }

  const deviceResult = await client.query<{ status: string }>(
    'SELECT status FROM devices WHERE id = $1',
    [deviceId],
  )
  const device = deviceResult.rows[0]
  if (!device) throw new ReservationError('not_found', 'The device was not found.')

  const borrowResult = await client.query<{ id: string }>(
    `SELECT id FROM borrow_records
     WHERE device_id = $1 AND status = 'active'
       AND borrowed_at < $3 AND due_at > $2
     LIMIT 1`,
    [deviceId, rangeStart, rangeEnd],
  )
  const reservationResult = await client.query<ReservationRow>(
    `SELECT ${reservationColumns} FROM reservations
     WHERE device_id = $1 AND status = 'active'
       AND start_at < $3 AND end_at > $2
     ORDER BY start_at, id`,
    [deviceId, rangeStart, rangeEnd],
  )
  const activeBorrowId = borrowResult.rows[0]?.id ?? null
  return {
    available:
      device.status === 'available' &&
      activeBorrowId === null &&
      reservationResult.rowCount === 0,
    deviceStatus: device.status,
    activeBorrowId,
    reservations: reservationResult.rows.map(toReservation),
  }
}

export async function createReservation(
  client: PoolClient,
  actorMemberId: string,
  reserverMemberId: string,
  deviceId: string,
  startAt: Date,
  endAt: Date,
  idempotencyKey: string,
  requestHash: string,
  reason = '',
): Promise<{ record: Reservation; replayed: boolean }> {
  const existing = await findIdempotency(
    client,
    actorMemberId,
    'reserve',
    idempotencyKey,
  )
  const replay = replayOrThrow(existing, requestHash)
  if (replay) return { record: replay, replayed: true }

  const nowResult = await client.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now')
  const now = nowResult.rows[0].now
  if (startAt.getTime() <= now.getTime() || startAt.getTime() >= endAt.getTime()) {
    throw new ReservationError(
      'invalid_interval',
      'A reservation must be a future interval with a start before its end.',
    )
  }

  const deviceResult = await client.query<{ status: string }>(
    'SELECT status FROM devices WHERE id = $1 FOR UPDATE',
    [deviceId],
  )
  const device = deviceResult.rows[0]
  if (!device) throw new ReservationError('not_found', 'The device was not found.')
  if (device.status !== 'available') {
    throw new ReservationError('conflict', 'The device is not available.')
  }

  const borrowResult = await client.query<{ id: string }>(
    `SELECT id FROM borrow_records
     WHERE device_id = $1 AND status = 'active'
       AND borrowed_at < $3 AND due_at > $2
     FOR UPDATE`,
    [deviceId, startAt, endAt],
  )
  if (borrowResult.rowCount !== 0) {
    throw new ReservationError('conflict', 'The device is currently borrowed.')
  }

  const result = await client.query<ReservationRow>(
    `INSERT INTO reservations
      (id, device_id, reserver_member_id, status, start_at, end_at)
     VALUES ($1, $2, $3, 'active', $4, $5)
     RETURNING ${reservationColumns}`,
    [randomUUID(), deviceId, reserverMemberId, startAt, endAt],
  )
  const record = toReservation(result.rows[0])
  await appendAudit(client, {
    entityType: 'reservation',
    entityId: record.id,
    action: 'reservation.created',
    actorMemberId,
    subjectMemberId: reserverMemberId,
    reason,
    afterState: { status: record.status, deviceId: record.deviceId },
    result: 'success',
  })
  await saveIdempotency(
    client,
    actorMemberId,
    'reserve',
    idempotencyKey,
    requestHash,
    record,
  )
  return { record, replayed: false }
}

export async function cancelReservation(
  client: PoolClient,
  actorMemberId: string,
  isAdmin: boolean,
  reservationId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ record: Reservation; replayed: boolean }> {
  const existing = await findIdempotency(
    client,
    actorMemberId,
    'cancel_reservation',
    idempotencyKey,
  )
  const replay = replayOrThrow(existing, requestHash)
  if (replay) return { record: replay, replayed: true }

  const result = await client.query<ReservationRow>(
    `SELECT ${reservationColumns} FROM reservations WHERE id = $1 FOR UPDATE`,
    [reservationId],
  )
  const current = result.rows[0]
  if (!current) throw new ReservationError('not_found', 'The reservation was not found.')
  if (!isAdmin && current.reserver_member_id !== actorMemberId) {
    throw new ReservationError('forbidden', 'A member can only cancel their own reservation.')
  }
  if (current.status !== 'active') {
    throw new ReservationError('invalid_state', 'The reservation is already closed.')
  }

  const cancelledAt = (await client.query<{ now: Date }>(
    'SELECT CURRENT_TIMESTAMP AS now',
  )).rows[0].now
  const updated = await client.query<ReservationRow>(
    `UPDATE reservations SET status = 'cancelled', cancelled_at = $2
     WHERE id = $1 RETURNING ${reservationColumns}`,
    [reservationId, cancelledAt],
  )
  const record = toReservation(updated.rows[0])
  await appendAudit(client, {
    entityType: 'reservation',
    entityId: record.id,
    action: 'reservation.cancelled',
    actorMemberId,
    subjectMemberId: record.reserverMemberId,
    afterState: { status: record.status, cancelledAt: record.cancelledAt },
    result: 'success',
  })
  await saveIdempotency(
    client,
    actorMemberId,
    'cancel_reservation',
    idempotencyKey,
    requestHash,
    record,
  )
  return { record, replayed: false }
}

export { hashRequest }
