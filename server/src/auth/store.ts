import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { LoginRequest, OidcIdentity } from './oidc.js'
import type { Member } from './membership.js'

interface MemberRow {
  id: string
  identity_subject: string
  display_name: string
  role: Member['role']
  status: Member['status']
}

interface LoginStateRow {
  state: string
  nonce: string
  code_verifier: string
  expires_at: Date
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

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function findMemberByIdentitySubject(
  client: PoolClient,
  subject: string,
): Promise<Member | null> {
  const result = await client.query<MemberRow>(
    `SELECT id, identity_subject, display_name, role, status
     FROM members WHERE identity_subject = $1`,
    [subject],
  )
  return result.rows[0] ? toMember(result.rows[0]) : null
}

export async function ensureMemberForIdentity(
  client: PoolClient,
  identity: OidcIdentity,
): Promise<Member> {
  const existing = await findMemberByIdentitySubject(client, identity.subject)
  if (existing) {
    const result = await client.query<MemberRow>(
      `UPDATE members
       SET display_name = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, identity_subject, display_name, role, status`,
      [existing.id, identity.displayName],
    )
    return toMember(result.rows[0])
  }

  const result = await client.query<MemberRow>(
    `INSERT INTO members (id, identity_subject, display_name, role, status)
     VALUES ($1, $2, $3, 'member', 'active')
     RETURNING id, identity_subject, display_name, role, status`,
    [`member_${randomUUID()}`, identity.subject, identity.displayName],
  )
  return toMember(result.rows[0])
}

export async function createSession(
  client: PoolClient,
  memberId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO sessions (id, member_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), memberId, tokenHash, expiresAt],
  )
}

export async function findMemberBySession(
  client: PoolClient,
  tokenHash: string,
): Promise<Member | null> {
  const result = await client.query<MemberRow>(
    `SELECT m.id, m.identity_subject, m.display_name, m.role, m.status
     FROM sessions s
     JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
    [tokenHash],
  )
  if (!result.rows[0]) return null

  await client.query(
    'UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = $1',
    [tokenHash],
  )
  return toMember(result.rows[0])
}

export async function deleteSession(
  client: PoolClient,
  tokenHash: string,
): Promise<void> {
  await client.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
}

export async function saveLoginState(
  client: PoolClient,
  request: LoginRequest,
  expiresAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO oidc_login_states (state, nonce, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [request.state, request.nonce, request.codeVerifier, expiresAt],
  )
}

export async function consumeLoginState(
  client: PoolClient,
  state: string,
): Promise<LoginRequest | null> {
  const result = await client.query<LoginStateRow>(
    `SELECT state, nonce, code_verifier, expires_at
     FROM oidc_login_states WHERE state = $1 FOR UPDATE`,
    [state],
  )
  const row = result.rows[0]
  if (!row) return null

  await client.query('DELETE FROM oidc_login_states WHERE state = $1', [state])
  if (row.expires_at.getTime() <= Date.now()) return null

  return {
    state: row.state,
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    authorizationUrl: '',
  }
}
