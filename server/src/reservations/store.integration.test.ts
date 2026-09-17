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
      subject: `reservation-member-${randomUUID()}`,
      displayName: 'Reservation Member',
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
      subject: `reservation-admin-${randomUUID()}`,
      displayName: 'Reservation Admin',
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
    payload: { name: `Reservation Device ${randomUUID()}` },
  })
  expect(response.statusCode).toBe(201)
  return response.json().id as string
}

function interval(hoursFromNow: number, hoursToNow: number) {
  return {
    startAt: new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString(),
    endAt: new Date(Date.now() + hoursToNow * 60 * 60 * 1000).toISOString(),
  }
}

describe('reservation and availability transactions', () => {
  it('rejects overlaps, allows touching endpoints, and makes cancellation idempotent', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const firstMember = await createMemberCookie()
    const secondMember = await createMemberCookie()
    const deviceId = await createDevice(app, adminCookie)
    const firstInterval = interval(2, 4)

    const first = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: { cookie: firstMember, 'idempotency-key': 'reservation-first' },
      payload: { deviceId, ...firstInterval },
    })
    const overlap = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: { cookie: secondMember, 'idempotency-key': 'reservation-overlap' },
      payload: { deviceId, ...interval(3, 5) },
    })
    const touching = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: { cookie: secondMember, 'idempotency-key': 'reservation-touching' },
      payload: { deviceId, ...interval(4, 5) },
    })
    const reservationId = first.json().id as string
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/cancel`,
      headers: { cookie: firstMember, 'idempotency-key': 'cancel-once' },
    })
    const cancelledReplay = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/cancel`,
      headers: { cookie: firstMember, 'idempotency-key': 'cancel-once' },
    })

    expect(first.statusCode).toBe(201)
    expect(overlap.statusCode).toBe(409)
    expect(touching.statusCode).toBe(201)
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().status).toBe('cancelled')
    expect(cancelledReplay.statusCode).toBe(200)
    expect(cancelledReplay.json().id).toBe(reservationId)
    await app.close()
  })

  it('rejects reservation and borrow conflicts in both creation orders', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const memberCookie = await createMemberCookie()
    const firstDeviceId = await createDevice(app, adminCookie)
    const futureInterval = interval(2, 4)
    const reservation = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: { cookie: memberCookie, 'idempotency-key': 'future-reservation' },
      payload: { deviceId: firstDeviceId, ...futureInterval },
    })
    const borrowAgainstReservation = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: memberCookie, 'idempotency-key': 'borrow-against-reservation' },
      payload: {
        deviceId: firstDeviceId,
        dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      },
    })

    const secondDeviceId = await createDevice(app, adminCookie)
    const borrow = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: memberCookie, 'idempotency-key': 'active-borrow' },
      payload: {
        deviceId: secondDeviceId,
        dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      },
    })
    const reservationAgainstBorrow = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: { cookie: memberCookie, 'idempotency-key': 'reservation-against-borrow' },
      payload: { deviceId: secondDeviceId, ...futureInterval },
    })

    expect(reservation.statusCode).toBe(201)
    expect(borrowAgainstReservation.statusCode).toBe(409)
    expect(borrow.statusCode).toBe(201)
    expect(reservationAgainstBorrow.statusCode).toBe(409)

    const returned = await app.inject({
      method: 'POST',
      url: `/api/borrows/${borrow.json().id}/return`,
      headers: { cookie: memberCookie, 'idempotency-key': 'return-active-borrow' },
      payload: {},
    })
    expect(returned.statusCode).toBe(200)
    await app.close()
  })

  it('allows at most one of two concurrent overlapping reservations', async () => {
    const app = buildApp({ pool })
    const deviceId = await createDevice(app, await createAdminCookie())
    const firstMember = await createMemberCookie()
    const secondMember = await createMemberCookie()
    const range = interval(6, 8)
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/reservations',
        headers: { cookie: firstMember, 'idempotency-key': 'concurrent-reservation-one' },
        payload: { deviceId, ...range },
      }),
      app.inject({
        method: 'POST',
        url: '/api/reservations',
        headers: { cookie: secondMember, 'idempotency-key': 'concurrent-reservation-two' },
        payload: { deviceId, ...range },
      }),
    ])
    const statuses = responses.map((response) => response.statusCode).sort()
    const active = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM reservations
       WHERE device_id = $1 AND status = 'active'`,
      [deviceId],
    )

    expect(statuses).toEqual([201, 409])
    expect(active.rows[0].count).toBe(1)
    await app.close()
  })

  it('allows a reservation after an active borrow due time when the intervals do not overlap', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const memberCookie = await createMemberCookie()
    const deviceId = await createDevice(app, adminCookie)
    const borrow = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: memberCookie, 'idempotency-key': 'borrow-before-later-reservation' },
      payload: { deviceId, dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
    })
    const laterReservation = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: { cookie: memberCookie, 'idempotency-key': 'later-reservation-after-due' },
      payload: { deviceId, ...interval(4, 5) },
    })
    expect(borrow.statusCode).toBe(201)
    expect(laterReservation.statusCode).toBe(201)
    await app.close()
  })

  it('reports current and future availability from authoritative records', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const memberCookie = await createMemberCookie()
    const deviceId = await createDevice(app, adminCookie)
    const range = interval(10, 12)
    const before = await app.inject({
      method: 'GET',
      url: `/api/devices/${deviceId}/availability?from=${encodeURIComponent(range.startAt)}&to=${encodeURIComponent(range.endAt)}`,
      headers: { cookie: memberCookie },
    })
    await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: { cookie: memberCookie, 'idempotency-key': 'availability-reservation' },
      payload: { deviceId, ...range },
    })
    const after = await app.inject({
      method: 'GET',
      url: `/api/devices/${deviceId}/availability?from=${encodeURIComponent(range.startAt)}&to=${encodeURIComponent(range.endAt)}`,
      headers: { cookie: memberCookie },
    })
    const touching = await app.inject({
      method: 'GET',
      url: `/api/devices/${deviceId}/availability?from=${encodeURIComponent(range.endAt)}&to=${encodeURIComponent(new Date(Date.now() + 13 * 60 * 60 * 1000).toISOString())}`,
      headers: { cookie: memberCookie },
    })

    expect(before.json().available).toBe(true)
    expect(after.json().available).toBe(false)
    expect(after.json().reservations).toHaveLength(1)
    expect(touching.json().available).toBe(true)
    await app.close()
  })
})
