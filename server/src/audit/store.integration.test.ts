import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendAudit, listAuditEntries } from './store.js'
import { ensureMemberForIdentity, withTransaction } from '../auth/store.js'

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

describe('append-only audit persistence', () => {
  it('keeps audit rows immutable at the database boundary', async () => {
    const member = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(client, {
        subject: `audit-${randomUUID()}`,
        displayName: 'Audit Tester',
      }),
    )
    const entityId = `audit-entity-${randomUUID()}`
    const auditId = randomUUID()

    await withTransaction(pool, async (client) => {
      await appendAudit(client, {
        entityType: 'test',
        entityId,
        action: 'test.created',
        actorMemberId: member.id,
        result: 'success',
      })
      const result = await client.query<{ id: string }>(
        'SELECT id FROM audit_entries WHERE entity_id = $1',
        [entityId],
      )
      expect(result.rows[0]?.id).toBeTruthy()
    })

    const row = await pool.query<{ id: string }>(
      'SELECT id FROM audit_entries WHERE entity_id = $1',
      [entityId],
    )
    const persistedId = row.rows[0].id
    expect(persistedId).not.toBe(auditId)

    await expect(
      pool.query('UPDATE audit_entries SET reason = $2 WHERE id = $1', [
        persistedId,
        'tampered',
      ]),
    ).rejects.toThrow(/append-only/i)
    await expect(
      pool.query('DELETE FROM audit_entries WHERE id = $1', [persistedId]),
    ).rejects.toThrow(/append-only/i)

    const listed = await withTransaction(pool, (client) =>
      listAuditEntries(client, 500),
    )
    expect(listed.some((entry) => entry.id === persistedId)).toBe(true)
  })
})
