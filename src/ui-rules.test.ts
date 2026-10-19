import { describe, expect, it } from 'vitest'
import {
  apiMessage,
  availabilitySummary,
  blocksForDay,
  borrowStatusLabel,
  occupancyBadge,
  occupancyBlocks,
  parseInputValue,
  reservationStatusLabel,
  suggestSlot,
  timelineDays,
  toInputValue,
  validateDueAt,
  validateInterval,
  type OccupancyBlock,
} from './ui-rules'

const now = new Date(2026, 9, 13, 10, 0)

function block(startHour: number, endHour: number, kind: OccupancyBlock['kind'] = 'reservation'): OccupancyBlock {
  return {
    kind,
    startAt: new Date(2026, 9, 13, startHour, 0),
    endAt: new Date(2026, 9, 13, endHour, 0),
    overdue: false,
  }
}

describe('occupancyBadge', () => {
  it('marks a free device as borrowable', () => {
    expect(occupancyBadge({ status: 'available', activeBorrow: null }, now)).toEqual({
      tone: 'positive',
      label: '可借用',
    })
  })

  it('shows the due day while a device is on loan', () => {
    const badge = occupancyBadge(
      {
        status: 'available',
        activeBorrow: {
          borrowedAt: new Date(2026, 9, 13, 9, 0).toISOString(),
          dueAt: new Date(2026, 9, 20, 18, 0).toISOString(),
        },
      },
      now,
    )
    expect(badge).toEqual({ tone: 'warning', label: '借出中 · 应还 10月20日' })
  })

  it('counts overdue days and falls back to a bare label inside one day', () => {
    const twoDaysLate = occupancyBadge(
      {
        status: 'available',
        activeBorrow: {
          borrowedAt: new Date(2026, 9, 9, 9, 0).toISOString(),
          dueAt: new Date(2026, 9, 11, 10, 0).toISOString(),
        },
      },
      now,
    )
    const hoursLate = occupancyBadge(
      {
        status: 'available',
        activeBorrow: {
          borrowedAt: new Date(2026, 9, 12, 9, 0).toISOString(),
          dueAt: new Date(2026, 9, 13, 7, 0).toISOString(),
        },
      },
      now,
    )
    expect(twoDaysLate).toEqual({ tone: 'danger', label: '已超期 2 天' })
    expect(hoursLate).toEqual({ tone: 'danger', label: '已超期' })
  })

  it('keeps lifecycle states visible and lets an overdue loan win', () => {
    expect(occupancyBadge({ status: 'maintenance', activeBorrow: null }, now).label).toBe('维修中')
    expect(occupancyBadge({ status: 'lost', activeBorrow: null }, now).label).toBe('已报失')
    expect(occupancyBadge({ status: 'archived', activeBorrow: null }, now).label).toBe('已归档')
    const overdueMaintenance = occupancyBadge(
      {
        status: 'maintenance',
        activeBorrow: {
          borrowedAt: new Date(2026, 9, 9, 9, 0).toISOString(),
          dueAt: new Date(2026, 9, 10, 9, 0).toISOString(),
        },
      },
      now,
    )
    expect(overdueMaintenance).toEqual({ tone: 'danger', label: '已超期 3 天' })
  })
})

describe('time input round trip', () => {
  it('formats and parses datetime-local values', () => {
    const date = new Date(2026, 9, 13, 9, 5)
    expect(toInputValue(date)).toBe('2026-10-13T09:05')
    expect(parseInputValue('2026-10-13T09:05')?.getTime()).toBe(date.getTime())
  })

  it('rejects malformed and impossible dates', () => {
    expect(parseInputValue('')).toBeNull()
    expect(parseInputValue('2026-10-13')).toBeNull()
    expect(parseInputValue('2026-02-31T10:00')).toBeNull()
  })
})

describe('validateInterval', () => {
  it('requires both ends and rejects a non-increasing interval', () => {
    expect(validateInterval('', '', now).ok).toBe(false)
    const reversed = validateInterval('2026-10-14T10:00', '2026-10-14T09:00', now)
    expect(reversed.ok).toBe(false)
    expect(reversed.fieldErrors.endAt).toBe('结束时间必须晚于开始时间')
    const equal = validateInterval('2026-10-14T10:00', '2026-10-14T10:00', now)
    expect(equal.fieldErrors.endAt).toBe('结束时间必须晚于开始时间')
  })

  it('rejects a start in the past and accepts a future minute-grained interval', () => {
    const past = validateInterval('2026-10-13T09:00', '2026-10-13T11:00', now)
    expect(past.fieldErrors.startAt).toBe('开始时间必须是将来时间')
    const fine = validateInterval('2026-10-13T10:30', '2026-10-13T12:00', now)
    expect(fine.ok).toBe(true)
    expect(fine.startAt?.getTime()).toBe(new Date(2026, 9, 13, 10, 30).getTime())
    expect(fine.endAt?.getTime()).toBe(new Date(2026, 9, 13, 12, 0).getTime())
  })
})

describe('validateDueAt', () => {
  it('requires a future return deadline', () => {
    expect(validateDueAt('', now).fieldErrors.dueAt).toBe('请选择归还期限')
    expect(validateDueAt('2026-10-13T10:00', now).fieldErrors.dueAt).toBe('归还期限必须是将来时间')
    const fine = validateDueAt('2026-10-14T18:00', now)
    expect(fine.ok).toBe(true)
    expect(fine.dueAt?.getTime()).toBe(new Date(2026, 9, 14, 18, 0).getTime())
  })
})

describe('timeline helpers', () => {
  it('builds seven labelled local days starting today', () => {
    const days = timelineDays(now)
    expect(days).toHaveLength(7)
    expect(days[0].label).toBe('今天')
    expect(days[0].isToday).toBe(true)
    expect(days[1].label).toBe('明天')
    expect(days[2].label).toContain('周')
    expect(new Set(days.map((day) => day.key)).size).toBe(7)
  })

  it('splits a borrow across days and clamps bars to day bounds', () => {
    const blocks = occupancyBlocks(
      {
        borrowedAt: new Date(2026, 9, 13, 20, 0).toISOString(),
        dueAt: new Date(2026, 9, 14, 10, 0).toISOString(),
      },
      [{ startAt: new Date(2026, 9, 14, 14, 0).toISOString(), endAt: new Date(2026, 9, 14, 16, 0).toISOString(), status: 'active' }],
      now,
    )
    const days = timelineDays(now)
    const firstDay = blocksForDay(blocks, days[0])
    const secondDay = blocksForDay(blocks, days[1])
    expect(firstDay).toHaveLength(1)
    expect(firstDay[0].kind).toBe('borrow')
    expect(firstDay[0].left).toBeCloseTo((20 / 24) * 100, 5)
    expect(firstDay[0].width).toBeCloseTo((4 / 24) * 100, 5)
    expect(secondDay).toHaveLength(2)
    expect(secondDay[0].width).toBeCloseTo((10 / 24) * 100, 5)
    expect(secondDay[1].label).toBe('预约')
  })

  it('ignores cancelled reservations and flags overdue borrows', () => {
    const blocks = occupancyBlocks(
      null,
      [
        { startAt: new Date(2026, 9, 15, 10, 0).toISOString(), endAt: new Date(2026, 9, 15, 12, 0).toISOString(), status: 'cancelled' },
        { startAt: new Date(2026, 9, 15, 10, 0).toISOString(), endAt: new Date(2026, 9, 15, 12, 0).toISOString(), status: 'completed' },
      ],
      now,
    )
    expect(blocks).toHaveLength(0)
    const overdue = occupancyBlocks(
      {
        borrowedAt: new Date(2026, 9, 12, 9, 0).toISOString(),
        dueAt: new Date(2026, 9, 12, 18, 0).toISOString(),
      },
      [],
      now,
    )
    expect(overdue[0].overdue).toBe(true)
  })

  it('suggests slots in free gaps with a lead time and a default length', () => {
    const days = timelineDays(now)
    const free = suggestSlot([], days[0], now)
    expect(free?.startAt.getTime()).toBe(new Date(2026, 9, 13, 10, 10).getTime())
    expect(free?.endAt.getTime()).toBe(new Date(2026, 9, 13, 12, 10).getTime())

    const busyBefore = suggestSlot([block(9, 12)], days[0], now)
    expect(busyBefore?.startAt.getTime()).toBe(new Date(2026, 9, 13, 12, 0).getTime())
    expect(busyBefore?.endAt.getTime()).toBe(new Date(2026, 9, 13, 14, 0).getTime())
  })

  it('falls back to the largest remaining gap or reports none', () => {
    const days = timelineDays(now)
    const shortGap = suggestSlot([block(0, 22, 'borrow')], days[0], now)
    expect(shortGap?.startAt.getTime()).toBe(new Date(2026, 9, 13, 22, 0).getTime())
    expect(shortGap?.endAt.getTime()).toBe(new Date(2026, 9, 14, 0, 0).getTime())

    const full = suggestSlot([block(0, 22), block(22, 24, 'borrow')], days[0], now)
    expect(full).toBeNull()

    const pastDay = suggestSlot([], days[0], new Date(2026, 9, 13, 23, 55))
    expect(pastDay).toBeNull()
  })
})

describe('derived labels and messages', () => {
  it('names borrow and reservation states without conflation', () => {
    expect(borrowStatusLabel('active')).toBe('借用中')
    expect(borrowStatusLabel('returned')).toBe('已归还')
    expect(reservationStatusLabel('active')).toBe('生效中')
    expect(reservationStatusLabel('cancelled')).toBe('已取消')
    expect(reservationStatusLabel('completed')).toBe('已完成')
  })

  it('summarises seven-day occupancy from the blocks', () => {
    expect(availabilitySummary([], now)).toBe('未来七天暂无占用')
    const borrowed = occupancyBlocks(
      { borrowedAt: new Date(2026, 9, 13, 9, 0).toISOString(), dueAt: new Date(2026, 9, 20, 18, 0).toISOString() },
      [
        { startAt: new Date(2026, 9, 15, 10, 0).toISOString(), endAt: new Date(2026, 9, 15, 12, 0).toISOString(), status: 'active' },
        { startAt: new Date(2026, 9, 16, 10, 0).toISOString(), endAt: new Date(2026, 9, 16, 12, 0).toISOString(), status: 'active' },
      ],
      now,
    )
    expect(availabilitySummary(borrowed, now)).toBe('借出中，应还 10月20日；2 个预约时段')
    const overdue = occupancyBlocks(
      { borrowedAt: new Date(2026, 9, 9, 9, 0).toISOString(), dueAt: new Date(2026, 9, 12, 9, 0).toISOString() },
      [],
      now,
    )
    expect(availabilitySummary(overdue, now)).toBe('当前借用已超期，请尽快归还')
  })

  it('maps error codes to deterministic copy', () => {
    expect(apiMessage({ code: 'invalid_transition', status: 409 })).toBe('该状态转换不被允许，设备状态未变更。')
    expect(apiMessage({ code: 'missing_reason', status: 400 })).toBe('该操作必须填写原因后才能提交。')
    expect(apiMessage({ code: 'conflict', status: 409 })).toBe('该设备的时段已被占用，请选择其他时间。')
    expect(apiMessage({ code: 'invalid_due_at', status: 400 })).toBe('归还期限必须是将来时间。')
    expect(apiMessage({ code: 'inactive_member', status: 403 })).toBe('当前账号已被停用，无法执行操作。')
    expect(apiMessage({ status: 401 })).toBe('登录状态已失效，请重新登录。')
    expect(apiMessage({ status: 403 })).toBe('当前账号没有执行此操作的权限。')
    expect(apiMessage(new TypeError('Failed to fetch'))).toBe('网络暂时不可用，请稍后重试。')
    expect(apiMessage({ code: 'unexpected', status: 500 })).toBe('操作未完成，请稍后重试。')
  })
})
