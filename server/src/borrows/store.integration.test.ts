import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createOpaqueToken, hashOpaqueToken, serializeCookie, sessionCookieName } from '../auth/session.js'
import { createSession, ensureMemberForIdentity, withTransaction } from '../auth/store.js'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')
}

const pool = new Pool({ connectionString: databaseUrl })

beforeAll(async () => {
  await pool.query('SELECT 1')
})

afterAll(async () => {
  await pool.end()
})

async function createMemberCookie(): Promise<string> {
  const member = await withTransaction(pool, (client) =>
    ensureMemberForIdentity(client, {
      subject: `borrow-member-${randomUUID()}`,
      displayName: 'Borrow Member',
    }),
  )
  const token = createOpaqueToken()
  await withTransaction(pool, (client) =>
    createSession(client, member.id, hashOpaqueToken(token), new Date(Date.now() + 60_000)),
  )
  return serializeCookie(sessionCookieName, token)
}

async function createAdminCookie(): Promise<string> {
  const member = await withTransaction(pool, (client) =>
    ensureMemberForIdentity(client, {
      subject: `borrow-admin-${randomUUID()}`,
      displayName: 'Borrow Admin',
    }),
  )
  await pool.query('UPDATE members SET role = $2 WHERE id = $1', [member.id, 'admin'])
  const token = createOpaqueToken()
  await withTransaction(pool, (client) =>
    createSession(client, member.id, hashOpaqueToken(token), new Date(Date.now() + 60_000)),
  )
  return serializeCookie(sessionCookieName, token)
}

async function createDevice(app: ReturnType<typeof buildApp>, cookie: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/devices',
    headers: { cookie },
    payload: { name: `Borrow Device ${randomUUID()}` },
  })
  expect(response.statusCode).toBe(201)
  return response.json().id as string
}

describe('borrow and return transactions', () => {
  it('supports an owned borrow, rejects another member return, and is idempotent', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const ownerCookie = await createMemberCookie()
    const otherCookie = await createMemberCookie()
    const deviceId = await createDevice(app, adminCookie)
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const first = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: ownerCookie, 'idempotency-key': 'borrow-once' },
      payload: { deviceId, dueAt },
    })
    const replay = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: ownerCookie, 'idempotency-key': 'borrow-once' },
      payload: { deviceId, dueAt },
    })
    const changedReplay = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: ownerCookie, 'idempotency-key': 'borrow-once' },
      payload: { deviceId, dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
    })
    const borrowId = first.json().id as string
    const otherReturn = await app.inject({
      method: 'POST',
      url: `/api/borrows/${borrowId}/return`,
      headers: { cookie: otherCookie, 'idempotency-key': 'other-return' },
      payload: {},
    })
    const returned = await app.inject({
      method: 'POST',
      url: `/api/borrows/${borrowId}/return`,
      headers: { cookie: ownerCookie, 'idempotency-key': 'owner-return' },
      payload: { returnNotes: 'Returned in good condition' },
    })
    const returnedReplay = await app.inject({
      method: 'POST',
      url: `/api/borrows/${borrowId}/return`,
      headers: { cookie: ownerCookie, 'idempotency-key': 'owner-return' },
      payload: { returnNotes: 'Returned in good condition' },
    })

    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().id).toBe(borrowId)
    expect(changedReplay.statusCode).toBe(409)
    expect(otherReturn.statusCode).toBe(403)
    expect(returned.statusCode).toBe(200)
    expect(returnedReplay.statusCode).toBe(200)
    expect(returnedReplay.json().returnedAt).toBe(returned.json().returnedAt)

    const counts = await pool.query<{ active: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*)::int AS total
       FROM borrow_records WHERE id = $1`,
      [borrowId],
    )
    const audit = await pool.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_entries
       WHERE entity_type = 'borrow' AND entity_id = $1
       ORDER BY occurred_at, id`,
      [borrowId],
    )
    expect(counts.rows[0]).toEqual({ active: 0, total: 1 })
    expect(audit.rows).toEqual([
      { action: 'borrow.created', result: 'success' },
      { action: 'borrow.returned', result: 'success' },
    ])
    await app.close()
  })

  it('allows at most one of two concurrent borrow requests for one device', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const deviceId = await createDevice(app, adminCookie)
    const firstMember = await createMemberCookie()
    const secondMember = await createMemberCookie()
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/borrows',
        headers: { cookie: firstMember, 'idempotency-key': 'concurrent-one' },
        payload: { deviceId, dueAt },
      }),
      app.inject({
        method: 'POST',
        url: '/api/borrows',
        headers: { cookie: secondMember, 'idempotency-key': 'concurrent-two' },
        payload: { deviceId, dueAt },
      }),
    ])
    const statuses = responses.map((response) => response.statusCode).sort()
    const active = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM borrow_records
       WHERE device_id = $1 AND status = 'active'`,
      [deviceId],
    )

    expect(statuses).toEqual([201, 409])
    expect(active.rows[0].count).toBe(1)
    await app.close()
  })

  it('rejects a due time that is not in the future without creating a record', async () => {
    const app = buildApp({ pool })
    const deviceId = await createDevice(app, await createAdminCookie())
    const response = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: await createMemberCookie(), 'idempotency-key': 'bad-due-time' },
      payload: { deviceId, dueAt: new Date(Date.now() - 1000).toISOString() },
    })

    expect(response.statusCode).toBe(400)
    const count = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM borrow_records WHERE device_id = $1',
      [deviceId],
    )
    expect(count.rows[0].count).toBe(0)
    await app.close()
  })
})
