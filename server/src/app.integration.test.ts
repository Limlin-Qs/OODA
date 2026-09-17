import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { ensureMemberForIdentity, createSession, withTransaction } from './auth/store.js'
import { createOpaqueToken, hashOpaqueToken, serializeCookie, sessionCookieName } from './auth/session.js'

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

async function createAuthenticatedMember(role: 'admin' | 'member') {
  const member = await withTransaction(pool, (client) =>
    ensureMemberForIdentity(client, {
      subject: `api-${role}-${randomUUID()}`,
      displayName: `API ${role}`,
    }),
  )
  await pool.query('UPDATE members SET role = $2 WHERE id = $1', [member.id, role])
  const token = createOpaqueToken()
  await withTransaction(pool, (client) =>
    createSession(client, member.id, hashOpaqueToken(token), new Date(Date.now() + 60_000)),
  )
  return serializeCookie(sessionCookieName, token)
}

describe('protected member API', () => {
  it('uses the session member and ignores a spoofed user id', async () => {
    const app = buildApp({ pool })
    const cookie = await createAuthenticatedMember('member')
    const response = await app.inject({
      method: 'GET',
      url: '/api/me?userId=admin-id',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().role).toBe('member')
    await app.close()
  })

  it('rejects a member from the administrator member list', async () => {
    const app = buildApp({ pool })
    const cookie = await createAuthenticatedMember('member')
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/members',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('allows an active administrator to read the member list', async () => {
    const app = buildApp({ pool })
    const cookie = await createAuthenticatedMember('admin')
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/members',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().some((entry: { role: string }) => entry.role === 'admin')).toBe(true)
    await app.close()
  })

  it('returns a stable forbidden response for an inactive administrator', async () => {
    const app = buildApp({ pool })
    const cookie = await createAuthenticatedMember('admin')
    const session = cookie.split('=')[1].split(';')[0]
    await pool.query(
      `UPDATE members SET status = 'inactive'
       WHERE id = (SELECT member_id FROM sessions WHERE token_hash = $1)`,
      [hashOpaqueToken(session)],
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/members',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'inactive_member' })
    await app.close()
  })

  it('exposes audit entries only to administrators and has no mutation route', async () => {
    const app = buildApp({ pool })
    const adminCookie = await createAuthenticatedMember('admin')
    const memberCookie = await createAuthenticatedMember('member')
    const adminResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { cookie: adminCookie },
    })
    const memberResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { cookie: memberCookie },
    })

    expect(adminResponse.statusCode).toBe(200)
    expect(adminResponse.json()).toEqual(expect.any(Array))
    expect(memberResponse.statusCode).toBe(403)
    expect(
      (await app.inject({
        method: 'DELETE',
        url: '/api/admin/audit/some-entry',
        headers: { cookie: adminCookie },
      })).statusCode,
    ).toBe(404)
    await app.close()
  })
})
