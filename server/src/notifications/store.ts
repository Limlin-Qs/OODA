import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../auth/store.js'

export interface Notification {
  id: string
  borrowId: string
  recipientMemberId: string
  stage: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  nextAttemptAt: Date
  lastError: string
  createdAt: Date
  sentAt: Date | null
  readAt: Date | null
}

export interface NotificationAttempt {
  id: string
  notificationId: string
  attemptNumber: number
  attemptedAt: Date
  result: 'sent' | 'failed'
  errorMessage: string
}

interface NotificationRow {
  id: string
  borrow_id: string
  recipient_member_id: string
  stage: string
  status: Notification['status']
  attempts: number
  next_attempt_at: Date
  last_error: string
  created_at: Date
  sent_at: Date | null
  read_at: Date | null
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    borrowId: row.borrow_id,
    recipientMemberId: row.recipient_member_id,
    stage: row.stage,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    readAt: row.read_at,
  }
}

const notificationColumns = `
  id, borrow_id, recipient_member_id, stage, status, attempts,
  next_attempt_at, last_error, created_at, sent_at, read_at
`

export async function scheduleOverdueReminders(client: PoolClient): Promise<number> {
  const result = await client.query(
    `INSERT INTO notifications (id, borrow_id, recipient_member_id, stage, status)
     SELECT 'notification_' || br.id || '_overdue', br.id, br.borrower_member_id,
            'overdue', 'pending'
     FROM borrow_records br
     WHERE br.status = 'active' AND br.due_at <= CURRENT_TIMESTAMP
     ON CONFLICT (borrow_id, stage) DO NOTHING`,
  )
  return result.rowCount ?? 0
}

export async function claimNextNotification(
  client: PoolClient,
): Promise<Notification | null> {
  const result = await client.query<NotificationRow>(
    `SELECT ${notificationColumns} FROM notifications
     WHERE status IN ('pending', 'failed')
       AND next_attempt_at <= CURRENT_TIMESTAMP
     ORDER BY next_attempt_at, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
  )
  const row = result.rows[0]
  if (!row) return null

  const updated = await client.query<NotificationRow>(
    `UPDATE notifications
     SET status = 'sending', attempts = attempts + 1
     WHERE id = $1
     RETURNING ${notificationColumns}`,
    [row.id],
  )
  return toNotification(updated.rows[0])
}

export async function finishNotification(
  client: PoolClient,
  notificationId: string,
  attemptNumber: number,
  sent: boolean,
  errorMessage = '',
): Promise<void> {
  const status: Notification['status'] = sent ? 'sent' : 'failed'
  await client.query(
    `UPDATE notifications SET
       status = $2,
       last_error = $3,
       sent_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE sent_at END,
       next_attempt_at = CASE
         WHEN $4 THEN CURRENT_TIMESTAMP
         ELSE CURRENT_TIMESTAMP + INTERVAL '1 second' * LEAST(60, POWER(2, attempts - 1))
       END
     WHERE id = $1`,
    [notificationId, status, errorMessage, sent],
  )
  await client.query(
    `INSERT INTO notification_attempts
      (id, notification_id, attempt_number, result, error_message)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), notificationId, attemptNumber, sent ? 'sent' : 'failed', errorMessage],
  )
}

export async function runOverdueReminderCycle(
  pool: Pool,
  send: (notification: Notification) => Promise<void> = async () => undefined,
  limit = 100,
): Promise<{ scheduled: number; attempted: number; sent: number; failed: number }> {
  const scheduled = await withTransaction(pool, (client) =>
    scheduleOverdueReminders(client),
  )
  let attempted = 0
  let sent = 0
  let failed = 0

  for (let index = 0; index < limit; index += 1) {
    const notification = await withTransaction(pool, (client) =>
      claimNextNotification(client),
    )
    if (!notification) break
    attempted += 1
    try {
      await send(notification)
      sent += 1
      await withTransaction(pool, (client) =>
        finishNotification(client, notification.id, notification.attempts, true),
      )
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : 'Notification failed.'
      await withTransaction(pool, (client) =>
        finishNotification(
          client,
          notification.id,
          notification.attempts,
          false,
          message,
        ),
      )
    }
  }

  return { scheduled, attempted, sent, failed }
}

export async function listNotifications(
  client: PoolClient,
  memberId: string,
  isAdmin: boolean,
): Promise<Notification[]> {
  const result = await client.query<NotificationRow>(
    `SELECT ${notificationColumns} FROM notifications
     WHERE $2 OR recipient_member_id = $1
     ORDER BY created_at DESC, id DESC`,
    [memberId, isAdmin],
  )
  return result.rows.map(toNotification)
}

export async function markNotificationRead(
  client: PoolClient,
  memberId: string,
  isAdmin: boolean,
  notificationId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
     WHERE id = $1 AND ($2 OR recipient_member_id = $3)`,
    [notificationId, isAdmin, memberId],
  )
  return result.rowCount !== 0
}
