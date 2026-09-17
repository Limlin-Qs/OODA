import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

export interface AuditInput {
  entityType: string
  entityId: string
  action: string
  actorMemberId: string
  subjectMemberId?: string
  reason?: string
  beforeState?: unknown
  afterState?: unknown
  result: 'success' | 'denied' | 'failure'
}

export interface AuditEntry {
  id: string
  entityType: string
  entityId: string
  action: string
  actorMemberId: string
  subjectMemberId: string | null
  reason: string
  beforeState: unknown
  afterState: unknown
  result: 'success' | 'denied' | 'failure'
  occurredAt: Date
}

export async function appendAudit(
  client: PoolClient,
  entry: AuditInput,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_entries
      (id, entity_type, entity_id, action, actor_member_id, subject_member_id,
       reason, before_state, after_state, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
    [
      randomUUID(),
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.actorMemberId,
      entry.subjectMemberId ?? null,
      entry.reason ?? '',
      entry.beforeState === undefined ? null : JSON.stringify(entry.beforeState),
      entry.afterState === undefined ? null : JSON.stringify(entry.afterState),
      entry.result,
    ],
  )
}

export async function listAuditEntries(
  client: PoolClient,
  limit = 100,
): Promise<AuditEntry[]> {
  const result = await client.query<{
    id: string
    entity_type: string
    entity_id: string
    action: string
    actor_member_id: string
    subject_member_id: string | null
    reason: string
    before_state: unknown
    after_state: unknown
    result: AuditEntry['result']
    occurred_at: Date
  }>(
    `SELECT id, entity_type, entity_id, action, actor_member_id,
            subject_member_id, reason, before_state, after_state, result, occurred_at
     FROM audit_entries ORDER BY occurred_at DESC, id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  )
  return result.rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actorMemberId: row.actor_member_id,
    subjectMemberId: row.subject_member_id,
    reason: row.reason,
    beforeState: row.before_state,
    afterState: row.after_state,
    result: row.result,
    occurredAt: row.occurred_at,
  }))
}
