export type MemberRole = 'admin' | 'member'
export type MemberStatus = 'active' | 'inactive'

export interface Member {
  id: string
  identitySubject: string
  displayName: string
  role: MemberRole
  status: MemberStatus
}

export interface VerifiedIdentity {
  subject: string
  displayName: string
}

export type AuthorizationErrorCode = 'forbidden' | 'inactive_member' | 'unauthenticated'

export class AuthorizationError extends Error {
  public readonly code: AuthorizationErrorCode

  constructor(code: AuthorizationErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'AuthorizationError'
  }
}

export function assertActiveMember(member: Member | null): asserts member is Member {
  if (!member) {
    throw new AuthorizationError('unauthenticated', 'A valid member session is required.')
  }

  if (member.status !== 'active') {
    throw new AuthorizationError(
      'inactive_member',
      'Inactive members cannot perform new operations.',
    )
  }
}

export function assertAdmin(member: Member | null): asserts member is Member {
  assertActiveMember(member)

  if (member.role !== 'admin') {
    throw new AuthorizationError(
      'forbidden',
      'This operation requires administrator permission.',
    )
  }
}

export function assertOwnRecord(member: Member, ownerId: string): void {
  assertActiveMember(member)

  if (member.role !== 'admin' && member.id !== ownerId) {
    throw new AuthorizationError(
      'forbidden',
      'A member can only operate on their own records.',
    )
  }
}

export function mapVerifiedIdentity(
  identity: VerifiedIdentity,
  existing: Member | null,
): Member {
  if (existing) return existing

  return {
    id: `member_${identity.subject}`,
    identitySubject: identity.subject,
    displayName: identity.displayName,
    role: 'member',
    status: 'active',
  }
}
