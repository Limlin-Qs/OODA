export interface Device {
  id: string
  assetNumber: string
  serialNumber: string | null
  name: string
  category: string
  status: 'available' | 'maintenance' | 'lost' | 'archived'
  maintenanceNotes: string
  attachmentNotes: string
  createdAt: string
  updatedAt: string
}

export interface Availability {
  available: boolean
  deviceStatus: string
  activeBorrowId: string | null
  reservations: Array<{
    id: string
    startAt: string
    endAt: string
    status: string
  }>
}

export interface Member {
  id: string
  displayName: string
  role: 'admin' | 'member'
  status: 'active' | 'inactive'
}

export interface Borrow {
  id: string
  deviceId: string
  borrowerMemberId: string
  status: 'active' | 'returned'
  borrowedAt: string
  dueAt: string
  returnedAt: string | null
  returnNotes: string
}

export interface Reservation {
  id: string
  deviceId: string
  reserverMemberId: string
  status: 'active' | 'cancelled' | 'completed'
  startAt: string
  endAt: string
  cancelledAt: string | null
}

export interface Notification {
  id: string
  borrowId: string
  recipientMemberId: string
  stage: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  nextAttemptAt: string
  lastError: string
  createdAt: string
  sentAt: string | null
  readAt: string | null
}

export interface AuditEntry {
  id: string
  entityType: string
  entityId: string
  action: string
  actorMemberId: string
  subjectMemberId: string | null
  reason: string
  result: 'success' | 'denied' | 'failure'
  occurredAt: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
    this.name = 'ApiError'
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...init?.headers,
    },
  })
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null
  if (!response.ok) {
    const code =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error ?? 'request_failed'
        : 'request_failed'
    throw new ApiError(response.status, code)
  }
  return payload as T
}

export function listDevices(): Promise<Device[]> {
  return requestJson<Device[]>('/api/devices')
}

export function getDevice(id: string): Promise<Device> {
  return requestJson<Device>(`/api/devices/${encodeURIComponent(id)}`)
}

export function getAvailability(
  id: string,
  from: Date,
  to: Date,
): Promise<Availability> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
  return requestJson<Availability>(
    `/api/devices/${encodeURIComponent(id)}/availability?${params.toString()}`,
  )
}

export function getMe(): Promise<Member> {
  return requestJson<Member>('/api/me')
}

export function listBorrows(): Promise<Borrow[]> {
  return requestJson<Borrow[]>('/api/borrows')
}

export function createBorrow(
  input: { deviceId: string; dueAt: string; reason?: string },
  idempotencyKey: string,
): Promise<Borrow> {
  return requestJson<Borrow>('/api/borrows', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  })
}

export function returnBorrow(
  borrowId: string,
  idempotencyKey: string,
  returnNotes = '',
): Promise<Borrow> {
  return requestJson<Borrow>(`/api/borrows/${encodeURIComponent(borrowId)}/return`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ returnNotes }),
  })
}

export function listReservations(): Promise<Reservation[]> {
  return requestJson<Reservation[]>('/api/reservations')
}

export function createReservation(
  input: { deviceId: string; startAt: string; endAt: string; reason?: string },
  idempotencyKey: string,
): Promise<Reservation> {
  return requestJson<Reservation>('/api/reservations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  })
}

export function cancelReservation(
  reservationId: string,
  idempotencyKey: string,
): Promise<Reservation> {
  return requestJson<Reservation>(
    `/api/reservations/${encodeURIComponent(reservationId)}/cancel`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
  )
}

export function listNotifications(): Promise<Notification[]> {
  return requestJson<Notification[]>('/api/notifications')
}

export function markNotificationRead(notificationId: string): Promise<void> {
  return requestJson<void>(
    `/api/notifications/${encodeURIComponent(notificationId)}/read`,
    { method: 'POST' },
  )
}

export function listAdminMembers(): Promise<Member[]> {
  return requestJson<Member[]>('/api/admin/members')
}

export function listAudit(): Promise<AuditEntry[]> {
  return requestJson<AuditEntry[]>('/api/admin/audit')
}

export function createDevice(input: {
  name: string
  category?: string
  serialNumber?: string
  maintenanceNotes?: string
  attachmentNotes?: string
}): Promise<Device> {
  return requestJson<Device>('/api/admin/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateDevice(
  id: string,
  input: Partial<Pick<Device, 'name' | 'category' | 'serialNumber' | 'status' | 'maintenanceNotes' | 'attachmentNotes'>> & { reason?: string },
): Promise<Device> {
  return requestJson<Device>(`/api/admin/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}
