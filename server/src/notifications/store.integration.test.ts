import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createOpaqueToken, hashOpaqueToken, serializeCookie, sessionCookieName } from '../auth/session.js'
import { createSession, ensureMemberForIdentity, withTransaction } from '../auth/store.js'
import { runOverdueReminderCycle } from './store.js'

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
      subject: `notification-member-${randomUUID()}`,
      displayName: 'Notification Member',
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
      subject: `notification-admin-${randomUUID()}`,
      displayName: 'Notification Admin',
    }),
  )
  await pool.query('UPDATE members SET role = $2 WHERE id = $1', [member.id, 'admin'])
  const token = createOpaqueToken()
  await withTransaction(pool, (client) =>
    createSession(client, member.id, hashOpaqueToken(token), new Date(Date.now() + 60_000)),
  )
  return serializeCookie(sessionCookieName, token)
}

async function createOverdueBorrow() {
  const app = buildApp({ pool })
  const adminCookie = await createAdminCookie()
  const memberCookie = await createMemberCookie()
  const deviceResponse = await app.inject({
    method: 'POST',
    url: '/api/admin/devices',
    headers: { cookie: adminCookie },
    payload: { name: `Notification Device ${randomUUID()}` },
  })
  const deviceId = deviceResponse.json().id as string
  const borrowResponse = await app.inject({
    method: 'POST',
    url: '/api/borrows',
    headers: { cookie: memberCookie, 'idempotency-key': `notification-borrow-${randomUUID()}` },
    payload: {
      deviceId,
      dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  })
  const borrowId = borrowResponse.json().id as string
  await pool.query(
    "UPDATE borrow_records SET due_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1",
    [borrowId],
  )
  return { app, borrowId, memberCookie }
}

describe('reliable overdue reminders', () => {
  it('deduplicates scheduling, records failures, retries, and keeps the borrow active', async () => {
    const { app, borrowId, memberCookie } = await createOverdueBorrow()
    const first = await runOverdueReminderCycle(pool, async () => {
      throw new Error('temporary channel failure')
    })
    const notification = await pool.query<{
      id: string
      status: string
      attempts: number
    }>(
      'SELECT id, status, attempts FROM notifications WHERE borrow_id = $1',
      [borrowId],
    )
    expect(first).toMatchObject({ scheduled: 1, attempted: 1, sent: 0, failed: 1 })
    expect(notification.rows).toHaveLength(1)
    expect(notification.rows[0]).toMatchObject({ status: 'failed', attempts: 1 })

    await pool.query(
      'UPDATE notifications SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = $1',
      [notification.rows[0].id],
    )
    const second = await runOverdueReminderCycle(pool)
    const third = await runOverdueReminderCycle(pool)
    const borrow = await pool.query<{ status: string }>(
      'SELECT status FROM borrow_records WHERE id = $1',
      [borrowId],
    )
    const attempts = await pool.query<{ result: string }>(
      `SELECT result FROM notification_attempts
       WHERE notification_id = $1 ORDER BY attempt_number`,
      [notification.rows[0].id],
    )
    const memberNotifications = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: memberCookie },
    })

    expect(second).toMatchObject({ scheduled: 0, attempted: 1, sent: 1, failed: 0 })
    expect(third).toMatchObject({ scheduled: 0, attempted: 0, sent: 0, failed: 0 })
    expect(borrow.rows[0].status).toBe('active')
    expect(attempts.rows).toEqual([{ result: 'failed' }, { result: 'sent' }])
    expect(memberNotifications.statusCode).toBe(200)
    expect(memberNotifications.json().some((entry: { borrowId: string }) => entry.borrowId === borrowId)).toBe(true)
    await app.close()
  })

  it('lets two concurrent scheduler runs create and deliver only one reminder', async () => {
    const { app, borrowId } = await createOverdueBorrow()
    const results = await Promise.all([
      runOverdueReminderCycle(pool),
      runOverdueReminderCycle(pool),
    ])
    const notificationCount = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE borrow_id = $1',
      [borrowId],
    )
    const attemptCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM notification_attempts
       WHERE notification_id = (SELECT id FROM notifications WHERE borrow_id = $1)`,
      [borrowId],
    )

    expect(results.reduce((sum, result) => sum + result.scheduled, 0)).toBe(1)
    expect(notificationCount.rows[0].count).toBe(1)
    expect(attemptCount.rows[0].count).toBe(1)
    await app.close()
  })
})
