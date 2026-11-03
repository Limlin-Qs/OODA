import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureMemberForIdentity, withTransaction } from '../auth/store.js'
import type { Member } from '../auth/membership.js'
import { updateMember } from './store.js'

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

async function createMember(role: 'admin' | 'member'): Promise<Member> {
  const subject = `member-admin-${role}-${randomUUID()}`
  const result = await pool.query<{
    id: string
    identity_subject: string
    display_name: string
    role: 'admin' | 'member'
    status: 'active' | 'inactive'
  }>(
    `INSERT INTO members (id, identity_subject, display_name, role, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id, identity_subject, display_name, role, status`,
    [`member_${randomUUID()}`, subject, `Member ${subject.slice(-8)}`, role],
  )
  const row = result.rows[0]
  return {
    id: row.id,
    identitySubject: row.identity_subject,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  }
}

async function latestAuditFor(entityId: string) {
  const result = await pool.query(
    `SELECT action, actor_member_id, subject_member_id, reason,
            before_state, after_state, result
     FROM audit_entries
     WHERE entity_type = 'member' AND entity_id = $1
     ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [entityId],
  )
  return result.rows[0]
}

describe('member administration', () => {
  it('changes a member role with a reason and writes audit in the same transaction', async () => {
    const admin = await createMember('admin')
    const target = await createMember('member')

    const updated = await withTransaction(pool, (client) =>
      updateMember(client, admin, target.id, { role: 'admin' }, '临时值班管理员'),
    )
    expect(updated.role).toBe('admin')

    const audit = await latestAuditFor(target.id)
    expect(audit).toMatchObject({
      action: 'member.update',
      actor_member_id: admin.id,
      subject_member_id: target.id,
      reason: '临时值班管理员',
      result: 'success',
    })
    expect(audit.before_state).toMatchObject({ role: 'member', status: 'active' })
    expect(audit.after_state).toMatchObject({ role: 'admin', status: 'active' })
  })

  it('deactivates a member and keeps the record traceable', async () => {
    const admin = await createMember('admin')
    const target = await createMember('member')

    const updated = await withTransaction(pool, (client) =>
      updateMember(client, admin, target.id, { status: 'inactive' }, '离开工作室'),
    )
    expect(updated.status).toBe('inactive')
    expect(updated.role).toBe('member')
  })

  it('rejects managing one self to avoid administrator lockout', async () => {
    const admin = await createMember('admin')

    await expect(
      withTransaction(pool, (client) =>
        updateMember(client, admin, admin.id, { status: 'inactive' }, '自我停用'),
      ),
    ).rejects.toMatchObject({ code: 'cannot_manage_self' })
  })

  it('refuses to demote or deactivate the last active administrator', async () => {
    const actor = await createMember('admin')
    const lastAdmin = await createMember('admin')
    // 让 actor 成为普通成员，lastAdmin 成为唯一启用管理员
    await pool.query(`UPDATE members SET role = 'member' WHERE id = $1`, [actor.id])

    await expect(
      withTransaction(pool, (client) =>
        updateMember(
          client,
          { ...actor, role: 'member' },
          lastAdmin.id,
          { role: 'member' },
          '降级最后一名管理员',
        ),
      ),
    ).rejects.toMatchObject({ code: 'last_active_admin' })
  })

  it('requires a non-empty reason and a real change target', async () => {
    const admin = await createMember('admin')
    const target = await createMember('member')

    await expect(
      withTransaction(pool, (client) =>
        updateMember(client, admin, target.id, { role: 'admin' }, '   '),
      ),
    ).rejects.toMatchObject({ code: 'missing_reason' })

    await expect(
      withTransaction(pool, (client) =>
        updateMember(client, admin, target.id, {}, '没有变更内容'),
      ),
    ).rejects.toMatchObject({ code: 'invalid_member_update' })

    await expect(
      withTransaction(pool, (client) =>
        updateMember(client, admin, 'member_missing', { role: 'admin' }, '不存在'),
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('treats a no-op update as a read and writes no audit', async () => {
    const admin = await createMember('admin')
    const target = await createMember('member')

    const updated = await withTransaction(pool, (client) =>
      updateMember(client, admin, target.id, { role: 'member' }, '重复提交相同角色'),
    )
    expect(updated.role).toBe('member')
    expect(await latestAuditFor(target.id)).toBeUndefined()
  })

  it('rolls back the role change when the audit write fails', async () => {
    const admin = await createMember('admin')
    const target = await createMember('member')

    await expect(
      withTransaction(pool, async (client) => {
        await updateMember(client, admin, target.id, { role: 'admin' }, '强制回滚')
        throw new Error('forced member rollback')
      }),
    ).rejects.toThrow('forced member rollback')

    const persisted = await pool.query('SELECT role FROM members WHERE id = $1', [
      target.id,
    ])
    expect(persisted.rows[0].role).toBe('member')
    expect(await latestAuditFor(target.id)).toBeUndefined()
  })
})

describe('bootstrap administrator subjects', () => {
  it('creates a bootstrap-listed identity as an administrator', async () => {
    const subject = `bootstrap-${randomUUID()}`
    const member = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(
        client,
        { subject, displayName: 'Bootstrap Admin' },
        [subject],
      ),
    )
    expect(member.role).toBe('admin')
  })

  it('creates an unlisted identity as an ordinary member', async () => {
    const subject = `ordinary-${randomUUID()}`
    const member = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(
        client,
        { subject, displayName: 'Ordinary Member' },
        [`other-${randomUUID()}`],
      ),
    )
    expect(member.role).toBe('member')
  })

  it('promotes an existing member on login when the subject becomes bootstrap-listed', async () => {
    const subject = `promote-${randomUUID()}`
    const created = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(client, { subject, displayName: 'Later Admin' }, []),
    )
    expect(created.role).toBe('member')

    const promoted = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(client, { subject, displayName: 'Later Admin' }, [subject]),
    )
    expect(promoted.role).toBe('admin')

    const audit = await latestAuditFor(created.id)
    expect(audit).toMatchObject({
      action: 'member.bootstrap_admin',
      reason: 'bootstrap_admin_subjects',
      result: 'success',
    })
  })

  it('does not demote an administrator whose subject leaves the bootstrap list', async () => {
    const subject = `keep-${randomUUID()}`
    await withTransaction(pool, (client) =>
      ensureMemberForIdentity(client, { subject, displayName: 'Keep Admin' }, [subject]),
    )
    const stillAdmin = await withTransaction(pool, (client) =>
      ensureMemberForIdentity(client, { subject, displayName: 'Keep Admin' }, []),
    )
    expect(stillAdmin.role).toBe('admin')
  })
})
