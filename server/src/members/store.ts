import type { PoolClient } from 'pg'
import { appendAudit } from '../audit/store.js'
import type { Member, MemberRole, MemberStatus } from '../auth/membership.js'

export type MemberErrorCode =
  | 'not_found'
  | 'missing_reason'
  | 'cannot_manage_self'
  | 'last_active_admin'
  | 'invalid_member_update'

export class MemberError extends Error {
  public readonly code: MemberErrorCode

  constructor(code: MemberErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'MemberError'
  }
}

interface MemberRow {
  id: string
  identity_subject: string
  display_name: string
  role: MemberRole
  status: MemberStatus
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    identitySubject: row.identity_subject,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  }
}

export interface MemberUpdate {
  role?: MemberRole
  status?: MemberStatus
}

// 管理员维护成员角色/状态：原因必填、不能操作自己、必须保留至少一名启用管理员。
// 业务写入与审计在同一事务内（由调用方提供的事务客户端保证）。
export async function updateMember(
  client: PoolClient,
  actor: Member,
  targetId: string,
  update: MemberUpdate,
  reason: string,
): Promise<Member> {
  const trimmedReason = reason.trim()
  if (!trimmedReason) {
    throw new MemberError('missing_reason', 'A reason is required to manage a member.')
  }
  if (
    (update.role !== undefined && !['admin', 'member'].includes(update.role)) ||
    (update.status !== undefined && !['active', 'inactive'].includes(update.status))
  ) {
    throw new MemberError('invalid_member_update', 'Unknown role or status value.')
  }
  if (update.role === undefined && update.status === undefined) {
    throw new MemberError('invalid_member_update', 'No member changes were provided.')
  }
  if (actor.id === targetId) {
    throw new MemberError(
      'cannot_manage_self',
      'Administrators cannot change their own role or status.',
    )
  }

  const targetResult = await client.query<MemberRow>(
    `SELECT id, identity_subject, display_name, role, status
     FROM members WHERE id = $1 FOR UPDATE`,
    [targetId],
  )
  const target = targetResult.rows[0] ? toMember(targetResult.rows[0]) : null
  if (!target) {
    throw new MemberError('not_found', 'The member does not exist.')
  }

  const nextRole = update.role ?? target.role
  const nextStatus = update.status ?? target.status
  const losesActiveAdmin =
    target.role === 'admin' &&
    target.status === 'active' &&
    (nextRole !== 'admin' || nextStatus !== 'active')
  if (losesActiveAdmin) {
    const admins = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM members
       WHERE role = 'admin' AND status = 'active' AND id <> $1`,
      [target.id],
    )
    if (Number(admins.rows[0]?.count ?? '0') === 0) {
      throw new MemberError(
        'last_active_admin',
        'At least one active administrator must remain.',
      )
    }
  }

  if (nextRole === target.role && nextStatus === target.status) {
    return target
  }

  const updated = await client.query<MemberRow>(
    `UPDATE members
     SET role = $2, status = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, identity_subject, display_name, role, status`,
    [target.id, nextRole, nextStatus],
  )

  await appendAudit(client, {
    entityType: 'member',
    entityId: target.id,
    action: 'member.update',
    actorMemberId: actor.id,
    subjectMemberId: target.id,
    reason: trimmedReason,
    beforeState: { role: target.role, status: target.status },
    afterState: { role: nextRole, status: nextStatus },
    result: 'success',
  })

  return toMember(updated.rows[0])
}
