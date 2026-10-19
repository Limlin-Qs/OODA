export type DeviceStatus = 'available' | 'maintenance' | 'lost' | 'archived'
export type BorrowStatus = 'active' | 'returned'
export type ReservationStatus = 'active' | 'cancelled' | 'completed'
export type Role = 'admin' | 'member'

export type DomainErrorCode =
  | 'forbidden'
  | 'inactive_member'
  | 'invalid_interval'
  | 'invalid_transition'
  | 'missing_reason'

export class DomainRuleError extends Error {
  public readonly code: DomainErrorCode

  constructor(
    code: DomainErrorCode,
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'DomainRuleError'
  }
}

const deviceTransitions: Record<DeviceStatus, readonly DeviceStatus[]> = {
  available: ['maintenance', 'lost', 'archived'],
  maintenance: ['available', 'archived'],
  lost: ['archived'],
  archived: [],
}

export function allowedDeviceTransitions(current: DeviceStatus): DeviceStatus[] {
  return [...deviceTransitions[current]]
}

export function transitionDevice(
  current: DeviceStatus,
  next: DeviceStatus,
): DeviceStatus {
  if (!deviceTransitions[current].includes(next)) {
    throw new DomainRuleError(
      'invalid_transition',
      `Device cannot transition from ${current} to ${next}.`,
    )
  }

  return next
}

export function transitionBorrow(
  current: BorrowStatus,
  next: BorrowStatus,
): BorrowStatus {
  if (current !== 'active' || next !== 'returned') {
    throw new DomainRuleError(
      'invalid_transition',
      `Borrow cannot transition from ${current} to ${next}.`,
    )
  }

  return next
}

export function transitionReservation(
  current: ReservationStatus,
  next: ReservationStatus,
): ReservationStatus {
  if (current !== 'active' || !['cancelled', 'completed'].includes(next)) {
    throw new DomainRuleError(
      'invalid_transition',
      `Reservation cannot transition from ${current} to ${next}.`,
    )
  }

  return next
}

export function assertValidInterval(start: Date, end: Date): void {
  if (start.getTime() >= end.getTime()) {
    throw new DomainRuleError(
      'invalid_interval',
      'An interval must start before it ends.',
    )
  }
}

export function intervalsOverlap(
  firstStart: Date,
  firstEnd: Date,
  secondStart: Date,
  secondEnd: Date,
): boolean {
  assertValidInterval(firstStart, firstEnd)
  assertValidInterval(secondStart, secondEnd)

  return (
    firstStart.getTime() < secondEnd.getTime() &&
    secondStart.getTime() < firstEnd.getTime()
  )
}

export function isOverdue(dueAt: Date, now: Date): boolean {
  return now.getTime() >= dueAt.getTime()
}

export type Command =
  | 'borrow'
  | 'return'
  | 'reserve'
  | 'cancel_reservation'
  | 'change_device_status'
  | 'view_audit'

export interface PermissionContext {
  actorId: string
  actorRole: Role
  actorActive: boolean
  ownerId?: string
  responsibleMemberId?: string
  reason?: string
}

function requireReasonForDelegatedAction(context: PermissionContext): void {
  if (
    context.responsibleMemberId &&
    context.responsibleMemberId !== context.actorId &&
    !context.reason?.trim()
  ) {
    throw new DomainRuleError(
      'missing_reason',
      'A reason is required when an administrator acts for another member.',
    )
  }
}

export function assertCanPerform(
  command: Command,
  context: PermissionContext,
): void {
  if (!context.actorActive) {
    throw new DomainRuleError(
      'inactive_member',
      'An inactive member cannot perform new operations.',
    )
  }

  if (context.actorRole === 'admin') {
    if (command === 'borrow' || command === 'reserve') {
      requireReasonForDelegatedAction(context)
    }
    return
  }

  if (command === 'change_device_status' || command === 'view_audit') {
    throw new DomainRuleError(
      'forbidden',
      'This command requires administrator permission.',
    )
  }

  if (
    (command === 'return' || command === 'cancel_reservation') &&
    context.ownerId !== context.actorId
  ) {
    throw new DomainRuleError(
      'forbidden',
      'A member can only operate on their own record.',
    )
  }

  if (
    (command === 'borrow' || command === 'reserve') &&
    context.responsibleMemberId &&
    context.responsibleMemberId !== context.actorId
  ) {
    throw new DomainRuleError(
      'forbidden',
      'A member can only create a record for themselves.',
    )
  }
}
