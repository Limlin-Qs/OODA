import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  cancelReservation,
  createBorrow,
  createReservation,
  createDevice,
  getAvailability,
  getDevice,
  getMe,
  listAdminMembers,
  listAudit,
  listBorrows,
  listDevices,
  listNotifications,
  listReservations,
  markNotificationRead,
  returnBorrow,
  updateDevice,
  type Availability,
  type Borrow,
  type Device,
  type DeviceStatus,
  type AuditEntry,
  type Member,
  type Notification,
  type Reservation,
} from './api'
import {
  apiMessage,
  availabilitySummary,
  blocksForDay,
  borrowStatusLabel,
  deviceStatusLabel,
  deviceStatusTone,
  formatDate,
  occupancyBadge,
  occupancyBlocks,
  reservationStatusLabel,
  suggestSlot,
  timelineDays,
  toInputValue,
  validateDueAt,
  validateInterval,
  type TimelineDay,
} from './ui-rules'
import './App.css'

type FeedbackArea = 'detail' | 'activity' | 'admin-form' | 'admin-ledger'

interface Feedback {
  tone: 'success' | 'error' | 'info'
  text: string
  area: FeedbackArea
}

function operationKey(): string {
  return globalThis.crypto.randomUUID()
}

function deviceName(devices: Device[], id: string): string {
  return devices.find((device) => device.id === id)?.name ?? '设备已归档'
}

function transitionChoices(device: Device): DeviceStatus[] {
  return [device.status, ...device.allowedTransitions]
}

function App() {
  const [view, setView] = useState<'catalog' | 'mine' | 'admin'>('catalog')
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Device | null>(null)
  const [availability, setAvailability] = useState<Availability | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<unknown>(null)
  const [member, setMember] = useState<Member | null>(null)
  const [activityState, setActivityState] = useState<'idle' | 'loading' | 'ready' | 'unauthenticated' | 'error'>('idle')
  const [adminState, setAdminState] = useState<'idle' | 'loading' | 'ready' | 'forbidden' | 'error'>('idle')
  const [adminMembers, setAdminMembers] = useState<Member[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [borrows, setBorrows] = useState<Borrow[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [dueAt, setDueAt] = useState('')
  const [dueError, setDueError] = useState<string | null>(null)
  const [reservationStart, setReservationStart] = useState('')
  const [reservationEnd, setReservationEnd] = useState('')
  const [intervalErrors, setIntervalErrors] = useState<{ startAt?: string; endAt?: string }>({})
  const [returnTarget, setReturnTarget] = useState<Borrow | null>(null)
  const [returnNotes, setReturnNotes] = useState('')
  const [archiveTarget, setArchiveTarget] = useState<Device | null>(null)
  const [newDeviceName, setNewDeviceName] = useState('')
  const [newDeviceCategory, setNewDeviceCategory] = useState('')
  const [newDeviceSerial, setNewDeviceSerial] = useState('')
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('available')
  const [deviceReason, setDeviceReason] = useState('')
  const [editDeviceId, setEditDeviceId] = useState<string | null>(null)

  function loadDevices() {
    setListState('loading')
    setError(null)
    void listDevices()
      .then((loadedDevices) => {
        setDevices(loadedDevices)
        setListState('ready')
      })
      .catch((loadError: unknown) => {
        setError(loadError)
        setListState('error')
      })
  }

  function refreshDetail(id: string) {
    const windowStart = new Date()
    void Promise.all([
      getDevice(id),
      getAvailability(id, windowStart, new Date(windowStart.getTime() + 7 * 24 * 60 * 60 * 1000)),
    ])
      .then(([device, currentAvailability]) => {
        setSelected(device)
        setAvailability(currentAvailability)
        setDetailState('ready')
      })
      .catch((detailError: unknown) => {
        setError(detailError)
        setDetailState('error')
      })
  }

  function loadActivity() {
    setActivityState('loading')
    void getMe()
      .then((currentMember) => {
        setMember(currentMember)
        return Promise.all([listBorrows(), listReservations(), listNotifications()])
      })
      .then(([loadedBorrows, loadedReservations, loadedNotifications]) => {
        setBorrows(loadedBorrows)
        setReservations(loadedReservations)
        setNotifications(loadedNotifications)
        setActivityState('ready')
      })
      .catch((activityError: unknown) => {
        setError(activityError)
        setActivityState(activityError instanceof ApiError && activityError.status === 401 ? 'unauthenticated' : 'error')
      })
  }

  function loadAdmin() {
    setAdminState('loading')
    void Promise.all([listAdminMembers(), listAudit()])
      .then(([members, entries]) => {
        setAdminMembers(members)
        setAuditEntries(entries)
        setAdminState('ready')
      })
      .catch((adminError: unknown) => {
        setError(adminError)
        setAdminState(adminError instanceof ApiError && adminError.status === 403 ? 'forbidden' : 'error')
      })
  }

  useEffect(() => {
    void listDevices()
      .then((loadedDevices) => {
        setDevices(loadedDevices)
        setListState('ready')
      })
      .catch((loadError: unknown) => {
        setError(loadError)
        setListState('error')
      })
  }, [])

  useEffect(() => {
    void getMe()
      .then((currentMember) => setMember(currentMember))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(new Date()), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (view !== 'mine') return
    void Promise.resolve().then(() => loadActivity())
  }, [view])

  useEffect(() => {
    if (view !== 'admin') return
    void Promise.resolve().then(() => loadAdmin())
  }, [view])

  useEffect(() => {
    if (!selectedId) return

    let cancelled = false
    void Promise.resolve()
      .then(() => {
        if (cancelled) return null
        setDetailState('loading')
        const windowStart = new Date()
        return Promise.all([
          getDevice(selectedId),
          getAvailability(selectedId, windowStart, new Date(windowStart.getTime() + 7 * 24 * 60 * 60 * 1000)),
        ])
      })
      .then((result) => {
        if (!result || cancelled) return
        const [device, currentAvailability] = result
        setSelected(device)
        setAvailability(currentAvailability)
        setDetailState('ready')
      })
      .catch((detailError: unknown) => {
        if (cancelled) return
        setError(detailError)
        setDetailState('error')
      })

    return () => {
      cancelled = true
    }
  }, [selectedId])

  const counts = useMemo(
    () => ({
      total: devices.length,
      available: devices.filter((device) => device.status === 'available').length,
      maintenance: devices.filter((device) => device.status === 'maintenance').length,
    }),
    [devices],
  )

  const timeline = useMemo(() => {
    const blocks = selected
      ? occupancyBlocks(selected.activeBorrow, availability?.reservations ?? [], now)
      : []
    return { blocks, days: timelineDays(now) }
  }, [selected, availability, now])

  function showView(nextView: 'catalog' | 'mine' | 'admin') {
    setView(nextView)
    if (nextView === 'catalog') setFeedback(null)
  }

  function showAdmin() {
    if (member?.role !== 'admin') return
    setView('admin')
  }

  function chooseDevice(id: string) {
    setSelectedId(id)
    setView('catalog')
    setFeedback(null)
    setDueError(null)
    setIntervalErrors({})
  }

  function handleBorrow() {
    if (!selectedId || actionBusy) return
    const check = validateDueAt(dueAt, new Date())
    if (!check.ok || !check.dueAt) {
      setDueError(check.fieldErrors.dueAt ?? '请选择归还期限')
      return
    }
    setDueError(null)
    setActionBusy('borrow')
    setFeedback(null)
    void createBorrow({ deviceId: selectedId, dueAt: check.dueAt.toISOString() }, operationKey())
      .then(() => {
        setFeedback({ tone: 'success', text: '借用已登记，设备占用状态已更新。', area: 'detail' })
        setDueAt('')
        loadDevices()
        refreshDetail(selectedId)
        if (member) loadActivity()
      })
      .catch((actionError: unknown) => {
        setDueAt('')
        setFeedback({ tone: 'error', text: apiMessage(actionError), area: 'detail' })
      })
      .finally(() => setActionBusy(null))
  }

  function handleReservation() {
    if (!selectedId || actionBusy) return
    const check = validateInterval(reservationStart, reservationEnd, new Date())
    if (!check.ok || !check.startAt || !check.endAt) {
      setIntervalErrors(check.fieldErrors)
      return
    }
    setIntervalErrors({})
    setActionBusy('reserve')
    setFeedback(null)
    void createReservation(
      {
        deviceId: selectedId,
        startAt: check.startAt.toISOString(),
        endAt: check.endAt.toISOString(),
      },
      operationKey(),
    )
      .then(() => {
        setFeedback({ tone: 'success', text: '预约已创建，冲突检查由服务端完成。', area: 'detail' })
        setReservationStart('')
        setReservationEnd('')
        loadDevices()
        refreshDetail(selectedId)
        if (member) loadActivity()
      })
      .catch((actionError: unknown) => {
        setReservationStart('')
        setReservationEnd('')
        setFeedback({ tone: 'error', text: apiMessage(actionError), area: 'detail' })
      })
      .finally(() => setActionBusy(null))
  }

  function applySuggestedSlot(day: TimelineDay) {
    const slot = suggestSlot(timeline.blocks, day, new Date())
    if (!slot) {
      setFeedback({ tone: 'error', text: '这一天没有足够长的空闲时段，请换一天或手动填写时间。', area: 'detail' })
      return
    }
    setReservationStart(toInputValue(slot.startAt))
    setReservationEnd(toInputValue(slot.endAt))
    setIntervalErrors({})
    setFeedback({
      tone: 'info',
      text: `已填入空闲时段 ${formatDate(slot.startAt)} — ${formatDate(slot.endAt)}，确认后可创建预约。`,
      area: 'detail',
    })
  }

  function confirmReturn() {
    if (!returnTarget || actionBusy) return
    const target = returnTarget
    setActionBusy(`return:${target.id}`)
    setFeedback(null)
    void returnBorrow(target.id, operationKey(), returnNotes.trim())
      .then(() => {
        setFeedback({ tone: 'success', text: '归还已确认，设备恢复可借用。', area: 'activity' })
        setReturnTarget(null)
        setReturnNotes('')
        loadActivity()
        loadDevices()
        if (selectedId) refreshDetail(selectedId)
      })
      .catch((actionError: unknown) => {
        setReturnTarget(null)
        setReturnNotes('')
        setFeedback({ tone: 'error', text: apiMessage(actionError), area: 'activity' })
      })
      .finally(() => setActionBusy(null))
  }

  function handleCancel(id: string) {
    if (actionBusy) return
    setActionBusy(`cancel:${id}`)
    setFeedback(null)
    void cancelReservation(id, operationKey())
      .then(() => {
        setFeedback({ tone: 'success', text: '预约已取消。', area: 'activity' })
        loadActivity()
        loadDevices()
        if (selectedId) refreshDetail(selectedId)
      })
      .catch((actionError: unknown) => {
        setFeedback({ tone: 'error', text: apiMessage(actionError), area: 'activity' })
      })
      .finally(() => setActionBusy(null))
  }

  function handleReadNotification(notification: Notification) {
    if (notification.readAt || actionBusy) return
    setActionBusy(`read:${notification.id}`)
    void markNotificationRead(notification.id)
      .then(() => setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item)))
      .catch((actionError: unknown) => setFeedback({ tone: 'error', text: apiMessage(actionError), area: 'activity' }))
      .finally(() => setActionBusy(null))
  }

  function handleCreateDevice() {
    if (!newDeviceName.trim() || actionBusy) return
    setActionBusy('create-device')
    setFeedback(null)
    void createDevice({
      name: newDeviceName.trim(),
      category: newDeviceCategory.trim() || undefined,
      serialNumber: newDeviceSerial.trim() || undefined,
    })
      .then(() => {
        setFeedback({ tone: 'success', text: '设备已登记，系统已生成唯一资产编号。', area: 'admin-form' })
        setNewDeviceName('')
        setNewDeviceCategory('')
        setNewDeviceSerial('')
        loadDevices()
        loadAdmin()
      })
      .catch((actionError: unknown) => {
        setNewDeviceName('')
        setNewDeviceCategory('')
        setNewDeviceSerial('')
        setFeedback({ tone: 'error', text: apiMessage(actionError), area: 'admin-form' })
      })
      .finally(() => setActionBusy(null))
  }

  function requestStatusUpdate(device: Device) {
    if (deviceStatus === 'archived' && device.status !== 'archived') {
      setArchiveTarget(device)
      return
    }
    handleUpdateDevice()
  }

  function handleUpdateDevice() {
    if (!editDeviceId || actionBusy) return
    const targetId = editDeviceId
    setActionBusy(`update-device:${targetId}`)
    setFeedback(null)
    void updateDevice(targetId, { status: deviceStatus, reason: deviceReason.trim() })
      .then(() => {
        setFeedback({ tone: 'success', text: '设备状态已更新，变更已写入审计。', area: 'admin-ledger' })
        setEditDeviceId(null)
        setDeviceStatus('available')
        setDeviceReason('')
        setArchiveTarget(null)
        loadDevices()
        loadAdmin()
        if (selectedId === targetId) refreshDetail(targetId)
      })
      .catch((actionError: unknown) => {
        setFeedback({ tone: 'error', text: apiMessage(actionError), area: 'admin-ledger' })
        setEditDeviceId(null)
        setDeviceStatus('available')
        setDeviceReason('')
        setArchiveTarget(null)
        loadDevices()
      })
      .finally(() => setActionBusy(null))
  }

  const unreadCount = notifications.filter((notification) => !notification.readAt).length
  const badgeFor = (device: Device) => occupancyBadge(device, now)

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={() => showView('catalog')}>
          <span className="brand-mark">S</span>
          <span><strong>Sharework</strong><small>Studio inventory</small></span>
        </a>
        <nav className="main-nav" aria-label="主导航">
          <button className={view === 'catalog' ? 'nav-link active' : 'nav-link'} type="button" onClick={() => showView('catalog')}>设备目录</button>
          <button className={view === 'mine' ? 'nav-link active' : 'nav-link'} type="button" onClick={() => showView('mine')}>我的记录{unreadCount > 0 && <span className="nav-badge">{unreadCount}</span>}</button>
          {member?.role === 'admin' && <button className={view === 'admin' ? 'nav-link active' : 'nav-link'} type="button" onClick={showAdmin}>管理工作台</button>}
        </nav>
        <div className="topbar-actions">
          <span className="system-status"><i />服务在线</span>
          {member ? <span className="member-chip">{member.displayName}</span> : <a className="login-link" href="/auth/login">登录</a>}
        </div>
      </header>

      <main className="page-content">
        {view === 'catalog' ? (
          <>
            <section className="hero-copy">
              <div>
                <p className="eyebrow">设备目录 / INVENTORY</p>
                <h1>找到下一件<br /><em>要用的设备。</em></h1>
                <p className="lede">查看工作室设备状态、当前占用与未来七天的可用性。</p>
              </div>
              <div className="hero-orbit" aria-hidden="true">
                <span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="orbit-core">24<br /><small>HUB</small></span>
              </div>
            </section>

            <section className="metric-row" aria-label="设备概览">
              <div className="metric-card accent"><span>全部设备</span><strong>{counts.total}</strong><small>已登记资产</small></div>
              <div className="metric-card"><span>可借用</span><strong>{counts.available}</strong><small>等待新的使用者</small></div>
              <div className="metric-card"><span>维护中</span><strong>{counts.maintenance}</strong><small>暂不可用</small></div>
              <div className="metric-note"><span className="spark">✦</span><p>设备状态由服务端实时计算，预约冲突会在提交时再次校验。</p></div>
            </section>

            <section className="catalog-section">
              <div className="section-heading">
                <div><p className="eyebrow">BROWSE</p><h2>设备总览</h2></div>
                <button className="refresh-button" type="button" onClick={loadDevices} disabled={listState === 'loading'}><span className={listState === 'loading' ? 'spin' : ''}>↻</span> 刷新目录</button>
              </div>
              {listState === 'loading' && <div className="state-panel loading-panel"><span className="loader" /><p>正在同步设备目录…</p></div>}
              {listState === 'error' && (
                <div className="state-panel error-panel">
                  <span className="state-icon">!</span><h3>目录暂时无法打开</h3><p>{apiMessage(error)}</p>
                  <div className="state-actions"><button type="button" className="primary-button" onClick={loadDevices}>重新加载</button>{error instanceof ApiError && error.status === 401 && <a className="secondary-button" href="/auth/login">去登录</a>}</div>
                </div>
              )}
              {listState === 'ready' && devices.length === 0 && <div className="state-panel empty-panel"><span className="state-icon">○</span><h3>还没有设备</h3><p>管理员登记第一件设备后，它会出现在这里。</p></div>}
              {listState === 'ready' && devices.length > 0 && (
                <div className="catalog-layout">
                  <div className="device-grid">
                    {devices.map((device, index) => (
                      <button className={`device-card ${selectedId === device.id ? 'selected' : ''}`} key={device.id} type="button" onClick={() => chooseDevice(device.id)}>
                        <span className="card-index">0{index + 1}</span><span className="device-glyph">{device.category ? device.category.slice(0, 1).toUpperCase() : 'D'}</span>
                        <span className="device-card-copy"><strong>{device.name}</strong><small>{device.assetNumber} · {device.category || '未分类'}</small></span>
                        <span className={`status-pill ${badgeFor(device).tone}`}><i />{badgeFor(device).label}</span><span className="card-arrow">↗</span>
                      </button>
                    ))}
                  </div>
                  <aside className="detail-panel" aria-live="polite">
                    {!selectedId && <div className="detail-placeholder"><span>↖</span><p>选择一件设备<br />查看详情与未来可用性</p></div>}
                    {selectedId && detailState === 'loading' && <div className="detail-placeholder"><span className="loader" /><p>正在加载设备详情…</p></div>}
                    {selectedId && detailState === 'error' && <div className="detail-placeholder error-text"><span>!</span><p>{apiMessage(error)}</p></div>}
                    {selected && selected.id === selectedId && detailState === 'ready' && (
                      <div className="detail-content">
                        <div className="detail-top"><span className={`status-pill ${badgeFor(selected).tone}`}><i />{badgeFor(selected).label}</span><span className="detail-id">{selected.assetNumber}</span></div>
                        <h3>{selected.name}</h3><p className="detail-category">{selected.category || '未分类设备'}</p>
                        <dl className="detail-list"><div><dt>序列号</dt><dd>{selected.serialNumber || '未登记'}</dd></div><div><dt>未来七天</dt><dd>{availabilitySummary(timeline.blocks, now)}</dd></div><div><dt>台账状态</dt><dd>{deviceStatusLabel[selected.status]}</dd></div></dl>
                        <div className="timeline-block">
                          <div className="timeline-heading"><span>未来 7 天占用</span><small>点击空闲时段可填入预约时间</small></div>
                          <div className="timeline">
                            {timeline.days.map((day) => (
                              <div className="timeline-row" key={day.key}>
                                <span className="timeline-day">{day.label}</span>
                                <div
                                  className="timeline-track"
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`为 ${day.label} 填入空闲时段`}
                                  onClick={() => applySuggestedSlot(day)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault()
                                      applySuggestedSlot(day)
                                    }
                                  }}
                                >
                                  {blocksForDay(timeline.blocks, day).map((block) => (
                                    <span
                                      key={`${block.kind}-${block.startAt.toISOString()}`}
                                      className={`timeline-bar ${block.kind}${block.overdue ? ' overdue' : ''}`}
                                      style={{ left: `${block.left}%`, width: `${block.width}%` }}
                                    >{block.label}</span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                        {selected.maintenanceNotes && <div className="maintenance-note"><span>i</span><p>{selected.maintenanceNotes}</p></div>}
                        {member ? (
                          <div className="action-stack">
                            <div className="field-wrap"><label>借用至<input type="datetime-local" value={dueAt} min={toInputValue(now)} onChange={(event) => { setDueAt(event.target.value); setDueError(null) }} /></label>{dueError && <span className="field-error" role="alert">{dueError}</span>}</div>
                            <button className="detail-action" type="button" onClick={handleBorrow} disabled={!dueAt || selected.status !== 'available' || selected.activeBorrow !== null || Boolean(actionBusy)} title={selected.activeBorrow ? '设备当前借出中，归还后才能再次借出' : undefined}>借用这件设备 <span>→</span></button>
                            <div className="action-divider"><span>或预约未来时段</span></div>
                            <div className="time-grid"><div className="field-wrap"><label>开始<input type="datetime-local" value={reservationStart} min={toInputValue(now)} onChange={(event) => { setReservationStart(event.target.value); setIntervalErrors((current) => ({ ...current, startAt: undefined })) }} /></label>{intervalErrors.startAt && <span className="field-error" role="alert">{intervalErrors.startAt}</span>}</div><div className="field-wrap"><label>结束<input type="datetime-local" value={reservationEnd} min={reservationStart || toInputValue(now)} onChange={(event) => { setReservationEnd(event.target.value); setIntervalErrors((current) => ({ ...current, endAt: undefined })) }} /></label>{intervalErrors.endAt && <span className="field-error" role="alert">{intervalErrors.endAt}</span>}</div></div>
                            <button className="secondary-action" type="button" onClick={handleReservation} disabled={!reservationStart || !reservationEnd || selected.status !== 'available' || Boolean(actionBusy)}>创建预约</button>
                            {feedback?.area === 'detail' && <p className={`action-feedback ${feedback.tone}`} role="status">{feedback.text}</p>}
                          </div>
                        ) : (
                          <a className="detail-action" href="/auth/login">登录后借用或预约 <span>→</span></a>
                        )}
                        <p className="updated-at">最后更新 · {formatDate(selected.updatedAt)}</p>
                      </div>
                    )}
                  </aside>
                </div>
              )}
            </section>
          </>
        ) : view === 'mine' ? (
          <section className="workspace-section">
            <div className="section-heading"><div><p className="eyebrow">MEMBER SPACE</p><h1>我的记录</h1><p className="lede">只显示当前登录成员负责的借用、预约和提醒。</p></div><button className="refresh-button" type="button" onClick={loadActivity} disabled={activityState === 'loading'}>↻ 刷新记录</button></div>
            {feedback?.area === 'activity' && <p className={`workspace-feedback ${feedback.tone}`} role="status">{feedback.text}</p>}
            {activityState === 'loading' && <div className="state-panel loading-panel"><span className="loader" /><p>正在读取你的记录…</p></div>}
            {activityState === 'unauthenticated' && <div className="state-panel error-panel"><span className="state-icon">!</span><h3>需要登录</h3><p>只有服务端确认的成员身份才能查看本人记录。</p><a className="primary-button" href="/auth/login">登录 Sharework</a></div>}
            {activityState === 'error' && <div className="state-panel error-panel"><span className="state-icon">!</span><h3>记录暂时无法打开</h3><p>{apiMessage(error)}</p><button className="primary-button" type="button" onClick={loadActivity}>重新加载</button></div>}
            {activityState === 'ready' && (
              <div className="workspace-grid">
                <div className="workspace-main">
                  <section className="record-section"><div className="record-heading"><h2>借用记录</h2><span>{borrows.length}</span></div>
                    {borrows.length === 0 ? <p className="record-empty">还没有借用记录。</p> : <div className="record-list">{borrows.map((borrow) => <article className="record-card" key={borrow.id}><div><strong>{deviceName(devices, borrow.deviceId)}</strong><small>{borrowStatusLabel(borrow.status)} · 借出于 {formatDate(borrow.borrowedAt)}{borrow.returnNotes ? ` · 归还说明：${borrow.returnNotes}` : ''}</small></div><span className={`record-status ${borrow.status === 'active' ? 'warning' : 'muted'}`}>{borrow.status === 'active' ? '应还 ' + formatDate(borrow.dueAt) : '已于 ' + formatDate(borrow.returnedAt ?? borrow.dueAt) }</span>{borrow.status === 'active' && <button className="small-action" type="button" onClick={() => { setReturnTarget(borrow); setReturnNotes('') }} disabled={Boolean(actionBusy)}>确认归还</button>}</article>)}</div>}
                  </section>
                  <section className="record-section"><div className="record-heading"><h2>预约记录</h2><span>{reservations.length}</span></div>
                    {reservations.length === 0 ? <p className="record-empty">还没有预约记录。</p> : <div className="record-list">{reservations.map((reservation) => <article className="record-card" key={reservation.id}><div><strong>{deviceName(devices, reservation.deviceId)}</strong><small>{formatDate(reservation.startAt)} — {formatDate(reservation.endAt)}</small></div><span className={`record-status ${reservation.status === 'active' ? 'positive' : 'muted'}`}>{reservationStatusLabel(reservation.status)}</span>{reservation.status === 'active' && <button className="small-action" type="button" onClick={() => handleCancel(reservation.id)} disabled={Boolean(actionBusy)}>取消预约</button>}</article>)}</div>}
                  </section>
                </div>
                <aside className="notification-panel"><div className="record-heading"><h2>提醒</h2><span>{unreadCount}</span></div>{notifications.length === 0 ? <p className="record-empty">暂无提醒。</p> : <div className="notification-list">{notifications.map((notification) => <button className={`notification-item ${notification.readAt ? 'read' : ''}`} key={notification.id} type="button" onClick={() => handleReadNotification(notification)}><i /> <span><strong>{notification.stage === 'overdue' ? '设备已超期' : '设备占用提醒'}</strong><small>借用记录 · {notification.borrowId.slice(0, 8)} · {notification.readAt ? '已读' : '点击标记已读'}</small></span></button>)}</div>}</aside>
              </div>
            )}
          </section>
        ) : (
          <section className="workspace-section admin-workspace">
            <div className="section-heading"><div><p className="eyebrow">ADMIN DESK</p><h1>管理工作台</h1><p className="lede">维护设备台账、处理生命周期状态，并查看必要的责任审计。</p></div><button className="refresh-button" type="button" onClick={loadAdmin} disabled={adminState === 'loading'}>↻ 刷新工作台</button></div>
            {adminState === 'loading' && <div className="state-panel loading-panel"><span className="loader" /><p>正在读取管理数据…</p></div>}
            {adminState === 'forbidden' && <div className="state-panel error-panel"><span className="state-icon">!</span><h3>没有管理权限</h3><p>管理员权限由服务端会话确认，不能通过前端切换。</p></div>}
            {adminState === 'error' && <div className="state-panel error-panel"><span className="state-icon">!</span><h3>工作台暂时无法打开</h3><p>{apiMessage(error)}</p><button className="primary-button" type="button" onClick={loadAdmin}>重新加载</button></div>}
            {adminState === 'ready' && <div className="admin-grid">
              <section className="record-section admin-form"><div className="record-heading"><h2>登记设备</h2><span>新</span></div><div className="form-grid"><label>设备名称<input value={newDeviceName} onChange={(event) => setNewDeviceName(event.target.value)} placeholder="例如：Sony A7 IV" /></label><label>类别<input value={newDeviceCategory} onChange={(event) => setNewDeviceCategory(event.target.value)} placeholder="相机 / 音频 / 灯光" /></label><label>序列号（可选）<input value={newDeviceSerial} onChange={(event) => setNewDeviceSerial(event.target.value)} /></label></div><button className="primary-button" type="button" onClick={handleCreateDevice} disabled={!newDeviceName.trim() || Boolean(actionBusy)}>登记设备</button>{feedback?.area === 'admin-form' && <p className={`form-feedback ${feedback.tone}`} role="status">{feedback.text}</p>}</section>
              <section className="record-section"><div className="record-heading"><h2>设备台账</h2><span>{devices.length}</span></div>{feedback?.area === 'admin-ledger' && <p className={`form-feedback ledger-feedback ${feedback.tone}`} role="status">{feedback.text}</p>}<div className="admin-device-list">{devices.length === 0 ? <p className="record-empty">暂无设备。</p> : devices.map((device) => <article className="admin-device-row" key={device.id}><div><strong>{device.name}</strong><small>{device.assetNumber} · {device.category || '未分类'}</small></div><span className={`record-status ${deviceStatusTone[device.status]}`}>{deviceStatusLabel[device.status]}</span><select value={editDeviceId === device.id ? deviceStatus : device.status} disabled={device.allowedTransitions.length === 0} onChange={(event) => { setEditDeviceId(device.id); setDeviceStatus(event.target.value as DeviceStatus); setDeviceReason('') }} aria-label={`${device.name}状态`}>{transitionChoices(device).map((status) => <option key={status} value={status}>{deviceStatusLabel[status]}</option>)}</select>{editDeviceId === device.id && deviceStatus !== device.status && <div className="admin-change"><input value={deviceReason} onChange={(event) => setDeviceReason(event.target.value)} placeholder="状态变更原因（必填）" /><button className="small-action" type="button" onClick={() => requestStatusUpdate(device)} disabled={!deviceReason.trim() || Boolean(actionBusy)}>保存</button></div>}</article>)}</div></section>
              <section className="record-section"><div className="record-heading"><h2>成员</h2><span>{adminMembers.length}</span></div><div className="member-list">{adminMembers.map((adminMember) => <div className="member-row" key={adminMember.id}><span>{adminMember.displayName}</span><small>{adminMember.role === 'admin' ? '管理员' : '成员'} · {adminMember.status === 'active' ? '启用' : '停用'}</small></div>)}</div></section>
              <section className="record-section audit-section"><div className="record-heading"><h2>最近审计</h2><span>{auditEntries.length}</span></div>{auditEntries.length === 0 ? <p className="record-empty">暂无审计记录。</p> : <div className="audit-list">{auditEntries.slice(0, 20).map((entry) => <div className="audit-row" key={entry.id}><div><strong>{entry.action}</strong><small>{entry.entityType} · {entry.entityId.slice(0, 12)}</small></div><span className={`record-status ${entry.result === 'success' ? 'positive' : 'warning'}`}>{entry.result === 'success' ? '成功' : entry.result === 'denied' ? '拒绝' : '失败'}</span><time>{formatDate(entry.occurredAt)}</time></div>)}</div>}</section>
            </div>}
          </section>
        )}
      </main>
      {returnTarget && (
        <div className="dialog-overlay" role="presentation" onClick={() => { if (!actionBusy) { setReturnTarget(null); setReturnNotes('') } }}>
          <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="return-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="return-dialog-title">确认归还「{deviceName(devices, returnTarget.deviceId)}」？</h3>
            <p className="dialog-note">归还后设备恢复可借用，借用记录转为已归还且不可撤销。如有损坏、配件缺失或保养需求，请在下方说明，管理员可在审计中追溯。</p>
            <label className="dialog-field">归还说明（可选）
              <textarea value={returnNotes} onChange={(event) => setReturnNotes(event.target.value)} placeholder="例如：镜头有轻微划痕，配件已齐全归还。" rows={3} />
            </label>
            <div className="dialog-actions">
              <button className="secondary-action" type="button" onClick={() => { setReturnTarget(null); setReturnNotes('') }} disabled={Boolean(actionBusy)}>取消</button>
              <button className="primary-button" type="button" onClick={confirmReturn} disabled={Boolean(actionBusy)}>{actionBusy ? '提交中…' : '确认归还'}</button>
            </div>
          </div>
        </div>
      )}
      {archiveTarget && (
        <div className="dialog-overlay" role="presentation" onClick={() => { if (!actionBusy) setArchiveTarget(null) }}>
          <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="archive-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="archive-dialog-title">归档「{archiveTarget.name}」？</h3>
            <p className="dialog-note">归档是终止状态：设备将退出可借用列表，之后不能再恢复为可借用或维修中。此操作会记录原因并写入审计，且不可撤销。</p>
            <div className="dialog-actions">
              <button className="secondary-action" type="button" onClick={() => setArchiveTarget(null)} disabled={Boolean(actionBusy)}>取消</button>
              <button className="danger-button" type="button" onClick={handleUpdateDevice} disabled={Boolean(actionBusy)}>{actionBusy ? '提交中…' : '确认归档'}</button>
            </div>
          </div>
        </div>
      )}
      <footer className="footer"><span>SHAREWORK / STUDIO RESOURCE SYSTEM</span><span>单工作室 · 实物设备 MVP</span></footer>
    </div>
  )
}

export default App
