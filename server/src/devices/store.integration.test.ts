import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { ensureMemberForIdentity, createSession, withTransaction } from '../auth/store.js'
import { createOpaqueToken, hashOpaqueToken, serializeCookie, sessionCookieName } from '../auth/session.js'

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

async function createAdminCookie(): Promise<string> {
  const member = await withTransaction(pool, (client) =>
    ensureMemberForIdentity(client, {
      subject: `device-admin-${randomUUID()}`,
      displayName: 'Device Admin',
    }),
  )
  await pool.query('UPDATE members SET role = $2 WHERE id = $1', [member.id, 'admin'])
  const token = createOpaqueToken()
  await withTransaction(pool, (client) =>
    createSession(client, member.id, hashOpaqueToken(token), new Date(Date.now() + 60_000)),
  )
  return serializeCookie(sessionCookieName, token)
}

async function createMemberCookie(): Promise<string> {
  const member = await withTransaction(pool, (client) =>
    ensureMemberForIdentity(client, {
      subject: `device-member-${randomUUID()}`,
      displayName: 'Device Member',
    }),
  )
  const token = createOpaqueToken()
  await withTransaction(pool, (client) =>
    createSession(client, member.id, hashOpaqueToken(token), new Date(Date.now() + 60_000)),
  )
  return serializeCookie(sessionCookieName, token)
}

describe('device ledger API', () => {
  it('lets an administrator create a device and a member view it', async () => {
    const adminCookie = await createAdminCookie()
    const memberCookie = await createMemberCookie()
    const app = buildApp({ pool })
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/devices',
      headers: { cookie: adminCookie },
      payload: { name: 'Camera', category: 'Imaging', serialNumber: `SN-${randomUUID()}` },
    })
    expect(createResponse.statusCode).toBe(201)
    const device = createResponse.json()
    expect(device.assetNumber).toMatch(/^EQ-/)
    expect(device.status).toBe('available')

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: memberCookie },
    })
    expect(listResponse.statusCode).toBe(200)
    expect(listResponse.json().some((entry: { id: string }) => entry.id === device.id)).toBe(true)
    await app.close()
  })

  it('rejects member attempts to create devices', async () => {
    const app = buildApp({ pool })
    const memberCookie = await createMemberCookie()
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/devices',
      headers: { cookie: memberCookie },
      payload: { name: 'Unauthorized Device' },
    })
    expect(response.statusCode).toBe(403)
    const audit = await pool.query(
      `SELECT action, result, reason FROM audit_entries
       WHERE entity_type = 'device_collection' AND entity_id = 'devices'
         AND action = 'device.create'
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    expect(audit.rows[0]).toEqual({
      action: 'device.create',
      result: 'denied',
      reason: 'forbidden',
    })
    await app.close()
  })

  it('enforces unique serial numbers and records the successful write audit', async () => {
    const app = buildApp({ pool })
    const cookie = await createAdminCookie()
    const serialNumber = `SN-${randomUUID()}`
    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/devices',
      headers: { cookie },
      payload: { name: 'Recorder', serialNumber },
    })
    const device = first.json()
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/admin/devices',
      headers: { cookie },
      payload: { name: 'Duplicate Recorder', serialNumber },
    })
    expect(first.statusCode).toBe(201)
    expect(duplicate.statusCode).toBe(409)

    const audit = await pool.query(
      `SELECT action, result FROM audit_entries
       WHERE entity_type = 'device' AND entity_id = $1`,
      [device.id],
    )
    expect(audit.rows).toEqual([{ action: 'device.created', result: 'success' }])
    await app.close()
  })

  it('enforces lifecycle transitions and does not write an audit on a rejected transition', async () => {
    const app = buildApp({ pool })
    const cookie = await createAdminCookie()
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/devices',
      headers: { cookie },
      payload: { name: 'Lost Device' },
    })
    const device = createResponse.json()
    const lost = await app.inject({
      method: 'PATCH',
      url: `/api/admin/devices/${device.id}`,
      headers: { cookie },
      payload: { status: 'lost', reason: '设备遗失，等待归档处理' },
    })
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/admin/devices/${device.id}`,
      headers: { cookie },
      payload: { status: 'available', reason: '误操作校正' },
    })
    expect(lost.statusCode).toBe(200)
    expect(invalid.statusCode).toBe(409)
    expect(
      (await pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_entries
         WHERE entity_type = 'device' AND entity_id = $1`,
        [device.id],
      )).rows[0].count,
    ).toBe(2)
    await app.close()
  })

  it('requires a reason for status changes and keeps members out of the ledger', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const memberCookie = await createMemberCookie()
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/devices',
      headers: { cookie: adminCookie },
      payload: { name: 'Reasoned Device' },
    })
    const device = created.json()
    const missingReason = await app.inject({
      method: 'PATCH',
      url: `/api/admin/devices/${device.id}`,
      headers: { cookie: adminCookie },
      payload: { status: 'maintenance' },
    })
    const memberUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/admin/devices/${device.id}`,
      headers: { cookie: memberCookie },
      payload: { status: 'maintenance', reason: '伪造管理操作' },
    })
    expect(missingReason.statusCode).toBe(400)
    expect(missingReason.json()).toEqual({ error: 'missing_reason' })
    expect(memberUpdate.statusCode).toBe(403)
    await app.close()
  })

  it('exposes occupancy and legal lifecycle transitions on the device read model', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAdminCookie()
    const memberCookie = await createMemberCookie()
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/devices',
      headers: { cookie: adminCookie },
      payload: { name: 'Occupied Device' },
    })
    const device = created.json()
    expect(device.activeBorrow).toBeNull()
    expect(device.allowedTransitions).toEqual(['maintenance', 'lost', 'archived'])

    const dueAt = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const borrow = await app.inject({
      method: 'POST',
      url: '/api/borrows',
      headers: { cookie: memberCookie, 'idempotency-key': 'read-model-borrow' },
      payload: { deviceId: device.id, dueAt: dueAt.toISOString() },
    })
    expect(borrow.statusCode).toBe(201)

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: memberCookie },
    })
    const listed = listResponse
      .json()
      .find((entry: { id: string }) => entry.id === device.id)
    expect(listed.activeBorrow.id).toBe(borrow.json().id)
    expect(
      Math.abs(new Date(listed.activeBorrow.dueAt).getTime() - dueAt.getTime()),
    ).toBeLessThan(1000)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/devices/${device.id}`,
      headers: { cookie: memberCookie },
    })
    expect(detail.json().activeBorrow.id).toBe(borrow.json().id)

    await app.inject({
      method: 'POST',
      url: `/api/borrows/${borrow.json().id}/return`,
      headers: { cookie: memberCookie, 'idempotency-key': 'read-model-return' },
      payload: {},
    })
    const afterReturn = await app.inject({
      method: 'GET',
      url: `/api/devices/${device.id}`,
      headers: { cookie: memberCookie },
    })
    expect(afterReturn.json().activeBorrow).toBeNull()

    await app.inject({
      method: 'PATCH',
      url: `/api/admin/devices/${device.id}`,
      headers: { cookie: adminCookie },
      payload: { status: 'archived', reason: '读模型验收后归档' },
    })
    const archived = await app.inject({
      method: 'GET',
      url: `/api/devices/${device.id}`,
      headers: { cookie: memberCookie },
    })
    expect(archived.json().status).toBe('archived')
    expect(archived.json().allowedTransitions).toEqual([])
    await app.close()
  })
})
