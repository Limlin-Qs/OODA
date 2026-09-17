import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertActiveMember } from './membership.js'
import { createOpaqueToken, hashOpaqueToken } from './session.js'
import {
  createSession,
  ensureMemberForIdentity,
  findMemberBySession,
  withTransaction,
} from './store.js'

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

describe('member and session persistence', () => {
  it('maps verified identities and resolves the server-side session member', async () => {
    const subject = `integration-${randomUUID()}`
    const identity = { subject, displayName: 'Integration Member' }
    const member = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(client, identity),
    )
    const token = createOpaqueToken()

    await withTransaction(pool, (client) =>
      createSession(
        client,
        member.id,
        hashOpaqueToken(token),
        new Date(Date.now() + 60_000),
      ),
    )

    const resolved = await withTransaction(pool, (client) =>
      findMemberBySession(client, hashOpaqueToken(token)),
    )
    expect(resolved).toMatchObject({
      id: member.id,
      identitySubject: subject,
      role: 'member',
      status: 'active',
    })
  })

  it('keeps an inactive member visible for history but rejects new operations', async () => {
    const subject = `inactive-${randomUUID()}`
    const member = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(client, {
        subject,
        displayName: 'Inactive Member',
      }),
    )
    await pool.query('UPDATE members SET status = $2 WHERE id = $1', [
      member.id,
      'inactive',
    ])

    const resolved = await withTransaction(pool, (client) =>
      findMemberBySession(client, hashOpaqueToken('never-created')),
    )
    expect(resolved).toBeNull()
    expect(() => assertActiveMember({ ...member, status: 'inactive' })).toThrow(
      /inactive/i,
    )
  })

  it('rolls back a member write when the transaction fails', async () => {
    const id = `rollback-${randomUUID()}`
    const subject = `rollback-subject-${randomUUID()}`

    await expect(
      withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO members (id, identity_subject, display_name, role, status)
           VALUES ($1, $2, $3, 'member', 'active')`,
          [id, subject, 'Rollback Member'],
        )
        throw new Error('forced integration rollback')
      }),
    ).rejects.toThrow('forced integration rollback')

    const result = await pool.query('SELECT id FROM members WHERE id = $1', [id])
    expect(result.rowCount).toBe(0)
  })
})
