import type { DeviceStatus } from './api'

// 纯展示与校验规则：不发起请求，不读系统时钟（时间由调用方传入），便于单元测试。

export type BadgeTone = 'positive' | 'warning' | 'danger' | 'muted'

export interface OccupancyBadge {
  tone: BadgeTone
  label: string
}

export interface ActiveBorrowLike {
  borrowedAt: string
  dueAt: string
}

export interface ReservationLike {
  startAt: string
  endAt: string
  status: string
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

export function toInputValue(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`
}

export function parseInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null
  }
  return date
}

export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return `${date.getMonth() + 1}月${date.getDate()}日 ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function formatDay(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export const deviceStatusLabel: Record<DeviceStatus, string> = {
  available: '可借用',
  maintenance: '维修中',
  lost: '已报失',
  archived: '已归档',
}

export const deviceStatusTone: Record<DeviceStatus, BadgeTone> = {
  available: 'positive',
  maintenance: 'warning',
  lost: 'danger',
  archived: 'muted',
}

export function borrowStatusLabel(status: string): string {
  if (status === 'active') return '借用中'
  if (status === 'returned') return '已归还'
  return status
}

export function reservationStatusLabel(status: string): string {
  if (status === 'active') return '生效中'
  if (status === 'cancelled') return '已取消'
  if (status === 'completed') return '已完成'
  return status
}

// 占用徽标：把“是否真的能借走”排在台账状态之前展示。
export function occupancyBadge(
  device: { status: DeviceStatus; activeBorrow: ActiveBorrowLike | null },
  now: Date,
): OccupancyBadge {
  const borrow = device.activeBorrow
  const overdue = borrow ? new Date(borrow.dueAt).getTime() <= now.getTime() : false
  if (borrow && overdue) {
    const days = Math.floor((now.getTime() - new Date(borrow.dueAt).getTime()) / 86_400_000)
    return days >= 1 ? { tone: 'danger', label: `已超期 ${days} 天` } : { tone: 'danger', label: '已超期' }
  }
  if (device.status === 'maintenance') return { tone: deviceStatusTone.maintenance, label: deviceStatusLabel.maintenance }
  if (device.status === 'lost') return { tone: deviceStatusTone.lost, label: deviceStatusLabel.lost }
  if (device.status === 'archived') return { tone: deviceStatusTone.archived, label: deviceStatusLabel.archived }
  if (borrow) return { tone: 'warning', label: `借出中 · 应还 ${formatDay(borrow.dueAt)}` }
  return { tone: 'positive', label: '可借用' }
}

export interface OccupancyBlock {
  kind: 'borrow' | 'reservation'
  startAt: Date
  endAt: Date
  overdue: boolean
}

export function occupancyBlocks(
  activeBorrow: ActiveBorrowLike | null,
  reservations: ReservationLike[],
  now: Date,
): OccupancyBlock[] {
  const blocks: OccupancyBlock[] = []
  if (activeBorrow) {
    const endAt = new Date(activeBorrow.dueAt)
    blocks.push({
      kind: 'borrow',
      startAt: new Date(activeBorrow.borrowedAt),
      endAt,
      overdue: endAt.getTime() <= now.getTime(),
    })
  }
  for (const reservation of reservations) {
    if (reservation.status !== 'active') continue
    blocks.push({
      kind: 'reservation',
      startAt: new Date(reservation.startAt),
      endAt: new Date(reservation.endAt),
      overdue: false,
    })
  }
  return blocks.sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
}

export function availabilitySummary(blocks: OccupancyBlock[], now: Date): string {
  if (blocks.some((block) => block.kind === 'borrow' && block.overdue)) {
    return '当前借用已超期，请尽快归还'
  }
  const upcoming = blocks.filter((block) => block.endAt.getTime() > now.getTime())
  if (upcoming.length === 0) return '未来七天暂无占用'
  const parts: string[] = []
  const borrow = upcoming.find((block) => block.kind === 'borrow')
  if (borrow) parts.push(`借出中，应还 ${formatDay(borrow.endAt)}`)
  const reservations = upcoming.filter((block) => block.kind === 'reservation').length
  if (reservations > 0) parts.push(`${reservations} 个预约时段`)
  return parts.join('；')
}

export interface TimelineDay {
  key: string
  label: string
  start: Date
  end: Date
  isToday: boolean
}

const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function timelineDays(now: Date, count = 7): TimelineDay[] {
  const days: TimelineDay[] = []
  for (let index = 0; index < count; index += 1) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index)
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index + 1)
    const label =
      index === 0
        ? '今天'
        : index === 1
          ? '明天'
          : `${weekdayLabels[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()}`
    days.push({
      key: `${start.getFullYear()}-${two(start.getMonth() + 1)}-${two(start.getDate())}`,
      label,
      start,
      end,
      isToday: index === 0,
    })
  }
  return days
}

export interface PositionedBlock extends OccupancyBlock {
  left: number
  width: number
  label: string
}

export function blocksForDay(blocks: OccupancyBlock[], day: TimelineDay): PositionedBlock[] {
  const span = day.end.getTime() - day.start.getTime()
  return blocks
    .filter((block) => block.endAt.getTime() > day.start.getTime() && block.startAt.getTime() < day.end.getTime())
    .map((block) => {
      const start = Math.max(block.startAt.getTime(), day.start.getTime())
      const end = Math.min(block.endAt.getTime(), day.end.getTime())
      return {
        ...block,
        left: ((start - day.start.getTime()) / span) * 100,
        width: Math.max(((end - start) / span) * 100, 1.5),
        label: block.kind === 'borrow' ? (block.overdue ? '超期借用' : '借用') : '预约',
      }
    })
}

export interface SuggestedSlot {
  startAt: Date
  endAt: Date
}

const slotLeadMs = 10 * 60_000
const minSlotMs = 30 * 60_000

// 点击时间轴空白处时给出一个建议时段：优先默认时长，放不下则取该天最大的空闲段。
export function suggestSlot(
  blocks: OccupancyBlock[],
  day: TimelineDay,
  now: Date,
  defaultMinutes = 120,
): SuggestedSlot | null {
  const dayStart = day.start.getTime()
  const dayEnd = day.end.getTime()
  const earliest = Math.max(dayStart, Math.floor(now.getTime() / 60_000) * 60_000 + slotLeadMs)
  if (earliest >= dayEnd) return null

  const busy: Array<[number, number]> = []
  for (const block of blocks) {
    const start = Math.max(block.startAt.getTime(), earliest)
    const end = Math.min(block.endAt.getTime(), dayEnd)
    if (end > start) busy.push([start, end])
  }
  busy.sort((left, right) => left[0] - right[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of busy) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  const gaps: Array<[number, number]> = []
  let cursor = earliest
  for (const [start, end] of merged) {
    if (start > cursor) gaps.push([cursor, start])
    cursor = Math.max(cursor, end)
  }
  if (cursor < dayEnd) gaps.push([cursor, dayEnd])

  const wanted = defaultMinutes * 60_000
  for (const [start, end] of gaps) {
    if (end - start >= wanted) {
      return { startAt: new Date(start), endAt: new Date(start + wanted) }
    }
  }
  let largest: [number, number] | null = null
  for (const gap of gaps) {
    const size = gap[1] - gap[0]
    if (size >= minSlotMs && (!largest || size > largest[1] - largest[0])) largest = gap
  }
  return largest ? { startAt: new Date(largest[0]), endAt: new Date(largest[1]) } : null
}

export interface FieldErrors {
  startAt?: string
  endAt?: string
  dueAt?: string
}

export interface IntervalCheck {
  ok: boolean
  fieldErrors: FieldErrors
  startAt: Date | null
  endAt: Date | null
}

export function validateInterval(startValue: string, endValue: string, now: Date): IntervalCheck {
  const fieldErrors: FieldErrors = {}
  const startAt = parseInputValue(startValue)
  const endAt = parseInputValue(endValue)
  if (!startAt) fieldErrors.startAt = '请选择开始时间'
  if (!endAt) fieldErrors.endAt = '请选择结束时间'
  if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
    fieldErrors.endAt = '结束时间必须晚于开始时间'
  }
  const nowMinute = Math.floor(now.getTime() / 60_000) * 60_000
  if (startAt && startAt.getTime() < nowMinute) {
    fieldErrors.startAt = '开始时间必须是将来时间'
  }
  return {
    ok: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    startAt: fieldErrors.startAt ? null : startAt,
    endAt: fieldErrors.endAt ? null : endAt,
  }
}

export interface DueAtCheck {
  ok: boolean
  fieldErrors: FieldErrors
  dueAt: Date | null
}

export function validateDueAt(dueValue: string, now: Date): DueAtCheck {
  const fieldErrors: FieldErrors = {}
  const dueAt = parseInputValue(dueValue)
  if (!dueAt) fieldErrors.dueAt = '请选择归还期限'
  const nowMinute = Math.floor(now.getTime() / 60_000) * 60_000
  if (dueAt && dueAt.getTime() <= nowMinute) {
    fieldErrors.dueAt = '归还期限必须是将来时间'
  }
  return {
    ok: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    dueAt: fieldErrors.dueAt ? null : dueAt,
  }
}

const codeMessages: Record<string, string> = {
  conflict: '该设备的时段已被占用，请选择其他时间。',
  invalid_state: '这条记录已经处理过，页面将同步最新状态。',
  invalid_transition: '该状态转换不被允许，设备状态未变更。',
  invalid_interval: '结束时间必须晚于开始时间，且时段必须是将来时间。',
  invalid_due_at: '归还期限必须是将来时间。',
  idempotency_conflict: '同一操作编号提交了不同内容，已被拒绝，请重新发起。',
  missing_reason: '该操作必须填写原因后才能提交。',
  inactive_member: '当前账号已被停用，无法执行操作。',
  forbidden: '当前账号没有执行此操作的权限。',
  unauthenticated: '登录状态已失效，请重新登录。',
  not_found: '记录不存在或已被处理，请刷新页面。',
  idempotency_key_required: '缺少操作标识，请刷新页面后重试。',
  invalid_borrow_request: '借用请求不完整，请检查填写内容。',
  invalid_reservation_request: '预约请求不完整，请检查填写内容。',
  invalid_device: '设备信息不合法，请刷新后重试。',
  invalid_device_status: '设备状态不合法，请刷新后重试。',
  configuration_required: '服务端运行配置尚未完成，请联系管理员。',
  request_failed: '操作未完成，请稍后重试。',
}

const statusMessages: Record<number, string> = {
  401: codeMessages.unauthenticated,
  403: codeMessages.forbidden,
  404: codeMessages.not_found,
  503: '服务尚未完成运行配置，请联系管理员。',
}

export function apiMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '')
    if (code in codeMessages) return codeMessages[code]
  }
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status?: unknown }).status)
    if (status in statusMessages) return statusMessages[status]
  }
  if (error instanceof Error) return '网络暂时不可用，请稍后重试。'
  return codeMessages.request_failed
}
