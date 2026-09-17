import { describe, expect, it } from 'vitest'
import {
  assertActiveMember,
  assertAdmin,
  assertOwnRecord,
  AuthorizationError,
  mapVerifiedIdentity,
  type Member,
} from './membership.js'

const activeMember: Member = {
  id: 'member-1',
  identitySubject: 'subject-1',
  displayName: 'Member One',
  role: 'member',
  status: 'active',
}

describe('member identity and lifecycle rules', () => {
  it('maps an unseen verified identity to an active ordinary member', () => {
    expect(
      mapVerifiedIdentity(
        { subject: 'subject-2', displayName: 'Member Two' },
        null,
      ),
    ).toEqual({
      id: 'member_subject-2',
      identitySubject: 'subject-2',
      displayName: 'Member Two',
      role: 'member',
      status: 'active',
    })
  })

  it('preserves the server member record for a known identity', () => {
    expect(
      mapVerifiedIdentity(
        { subject: activeMember.identitySubject, displayName: 'Changed Name' },
        activeMember,
      ),
    ).toBe(activeMember)
  })

  it('rejects missing and inactive members before new operations', () => {
    expect(() => assertActiveMember(null)).toThrowError(AuthorizationError)
    expect(() =>
      assertActiveMember({ ...activeMember, status: 'inactive' }),
    ).toThrowError(/inactive/i)
  })
})

describe('server-side member permissions', () => {
  it('allows only admins to use administrative operations', () => {
    expect(() => assertAdmin(activeMember)).toThrowError(AuthorizationError)
    expect(() =>
      assertAdmin({ ...activeMember, role: 'admin' }),
    ).not.toThrow()
  })

  it('allows members to operate on themselves but not another member', () => {
    expect(() => assertOwnRecord(activeMember, activeMember.id)).not.toThrow()
    expect(() => assertOwnRecord(activeMember, 'member-2')).toThrowError(
      /own records/i,
    )
    expect(() =>
      assertOwnRecord({ ...activeMember, role: 'admin' }, 'member-2'),
    ).not.toThrow()
  })

  it('does not let an inactive administrator bypass lifecycle checks', () => {
    expect(() =>
      assertAdmin({ ...activeMember, role: 'admin', status: 'inactive' }),
    ).toThrowError(/inactive/i)
  })
})
