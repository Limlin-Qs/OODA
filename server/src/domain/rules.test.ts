import { describe, expect, it } from 'vitest'
import {
  assertCanPerform,
  DomainRuleError,
  intervalsOverlap,
  isOverdue,
  transitionBorrow,
  transitionDevice,
  transitionReservation,
} from './rules.js'

const date = (value: string) => new Date(value)

describe('device, borrow, and reservation state machines', () => {
  it('allows only the confirmed device transitions', () => {
    expect(transitionDevice('available', 'maintenance')).toBe('maintenance')
    expect(transitionDevice('maintenance', 'available')).toBe('available')
    expect(transitionDevice('lost', 'archived')).toBe('archived')
    expect(() => transitionDevice('archived', 'available')).toThrow(
      DomainRuleError,
    )
  })

  it('does not allow reopening a returned borrow', () => {
    expect(transitionBorrow('active', 'returned')).toBe('returned')
    expect(() => transitionBorrow('returned', 'active')).toThrow(
      DomainRuleError,
    )
  })

  it('allows an active reservation to finish or be cancelled only once', () => {
    expect(transitionReservation('active', 'cancelled')).toBe('cancelled')
    expect(transitionReservation('active', 'completed')).toBe('completed')
    expect(() => transitionReservation('cancelled', 'completed')).toThrow(
      DomainRuleError,
    )
  })
})

describe('half-open time intervals', () => {
  it('treats touching endpoints as non-overlapping', () => {
    expect(
      intervalsOverlap(
        date('2026-09-14T10:00:00+08:00'),
        date('2026-09-14T11:00:00+08:00'),
        date('2026-09-14T11:00:00+08:00'),
        date('2026-09-14T12:00:00+08:00'),
      ),
    ).toBe(false)
  })

  it('detects proper overlap in either order', () => {
    const firstStart = date('2026-09-14T10:00:00+08:00')
    const firstEnd = date('2026-09-14T12:00:00+08:00')
    const secondStart = date('2026-09-14T11:00:00+08:00')
    const secondEnd = date('2026-09-14T13:00:00+08:00')

    expect(intervalsOverlap(firstStart, firstEnd, secondStart, secondEnd)).toBe(
      true,
    )
    expect(intervalsOverlap(secondStart, secondEnd, firstStart, firstEnd)).toBe(
      true,
    )
  })

  it('rejects empty and backwards intervals', () => {
    expect(() =>
      intervalsOverlap(
        date('2026-09-14T10:00:00+08:00'),
        date('2026-09-14T10:00:00+08:00'),
        date('2026-09-14T11:00:00+08:00'),
        date('2026-09-14T12:00:00+08:00'),
      ),
    ).toThrow(DomainRuleError)
  })
})

describe('server-time overdue rule', () => {
  it('is overdue at the exact due time', () => {
    const dueAt = date('2026-09-14T12:00:00+08:00')
    expect(isOverdue(dueAt, dueAt)).toBe(true)
    expect(isOverdue(dueAt, date('2026-09-14T11:59:59+08:00'))).toBe(false)
  })
})

describe('permission matrix', () => {
  const member = {
    actorId: 'member-1',
    actorRole: 'member' as const,
    actorActive: true,
  }

  it('allows a member to create their own borrow and reservation', () => {
    expect(() =>
      assertCanPerform('borrow', {
        ...member,
        responsibleMemberId: 'member-1',
      }),
    ).not.toThrow()
    expect(() =>
      assertCanPerform('reserve', {
        ...member,
        responsibleMemberId: 'member-1',
      }),
    ).not.toThrow()
  })

  it('rejects member access to administrative commands and other records', () => {
    expect(() => assertCanPerform('change_device_status', member)).toThrow(
      DomainRuleError,
    )
    expect(() =>
      assertCanPerform('return', { ...member, ownerId: 'member-2' }),
    ).toThrow(DomainRuleError)
    expect(() =>
      assertCanPerform('borrow', {
        ...member,
        responsibleMemberId: 'member-2',
      }),
    ).toThrow(DomainRuleError)
  })

  it('requires a reason for delegated administrator actions', () => {
    const admin = {
      actorId: 'admin-1',
      actorRole: 'admin' as const,
      actorActive: true,
      responsibleMemberId: 'member-1',
    }

    expect(() => assertCanPerform('borrow', admin)).toThrow(DomainRuleError)
    expect(() =>
      assertCanPerform('borrow', { ...admin, reason: 'Front desk handover' }),
    ).not.toThrow()
  })

  it('rejects inactive members before checking command permissions', () => {
    expect(() =>
      assertCanPerform('borrow', { ...member, actorActive: false }),
    ).toThrowError(/inactive member/i)
  })
})
