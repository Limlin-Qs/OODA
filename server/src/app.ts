import Fastify, { type FastifyInstance } from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { assertActiveMember, assertAdmin, AuthorizationError } from './auth/membership.js'
import { OidcClient } from './auth/oidc.js'
import {
  createOpaqueToken,
  hashOpaqueToken,
  loginStateCookieName,
  parseCookies,
  serializeCookie,
  sessionCookieName,
} from './auth/session.js'
import {
  consumeLoginState,
  createSession,
  deleteSession,
  ensureMemberForIdentity,
  findMemberBySession,
  saveLoginState,
  withTransaction,
} from './auth/store.js'
import { assertCanPerform, DomainRuleError, type DeviceStatus } from './domain/rules.js'
import { appendAudit, listAuditEntries } from './audit/store.js'
import {
  BorrowError,
  borrowDevice,
  findBorrow,
  hashRequest,
  listBorrows,
  returnBorrow,
} from './borrows/store.js'
import {
  cancelReservation,
  createReservation,
  findReservation,
  getAvailability,
  listReservations,
  ReservationError,
} from './reservations/store.js'
import { listNotifications, markNotificationRead } from './notifications/store.js'
import {
  createDevice,
  findDevice,
  listDevices,
  updateDevice,
  type CreateDeviceInput,
  type UpdateDeviceInput,
} from './devices/store.js'

export interface AppDependencies {
  pool?: Pool
  oidc?: OidcClient
  sessionTtlSeconds?: number
}

function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production'
}

function unavailable(reply: FastifyReply, message: string) {
  return reply.code(503).send({ error: 'configuration_required', message })
}

async function currentMember(
  request: FastifyRequest,
  pool: Pool,
): Promise<Awaited<ReturnType<typeof findMemberBySession>>> {
  const token = parseCookies(request.headers.cookie).get(sessionCookieName)
  if (!token) return null

  return withTransaction(pool, (client) =>
    findMemberBySession(client, hashOpaqueToken(token)),
  )
}

export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const app = Fastify({ logger: false })
  const sessionTtlSeconds = dependencies.sessionTtlSeconds ?? 8 * 60 * 60

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      const statusCode = error.code === 'unauthenticated' ? 401 : 403
      return reply.code(statusCode).send({ error: error.code })
    }
    if (error instanceof DomainRuleError) {
      const statusCode = ['invalid_interval', 'missing_reason'].includes(error.code) ? 400 : 409
      return reply.code(statusCode).send({ error: error.code })
    }
    if (error instanceof BorrowError) {
      const statusCode =
        error.code === 'forbidden'
          ? 403
          : error.code === 'not_found'
            ? 404
            : error.code === 'invalid_due_at'
              ? 400
              : 409
      return reply.code(statusCode).send({ error: error.code })
    }
    if (error instanceof ReservationError) {
      const statusCode =
        error.code === 'forbidden'
          ? 403
          : error.code === 'not_found'
            ? 404
            : error.code === 'invalid_interval'
              ? 400
              : 409
      return reply.code(statusCode).send({ error: error.code })
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === '23505' || error.code === '23P01')
    ) {
      return reply.code(409).send({ error: 'conflict' })
    }
    return reply.send(error)
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/auth/login', async (_request, reply) => {
    if (!dependencies.oidc || !dependencies.pool) {
      return unavailable(reply, 'OIDC and database configuration are required.')
    }

    const login = await dependencies.oidc.createLoginRequest()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await withTransaction(dependencies.pool, (client) =>
      saveLoginState(client, login, expiresAt),
    )
    reply.header(
      'Set-Cookie',
      serializeCookie(loginStateCookieName, login.state, {
        maxAge: 10 * 60,
        secure: secureCookies(),
      }),
    )
    return reply.redirect(login.authorizationUrl)
  })

  app.get<{
    Querystring: { code?: string; state?: string; error?: string }
  }>('/auth/callback', async (request, reply) => {
    if (request.query.error) {
      return reply.code(400).send({ error: 'oidc_denied' })
    }
    if (!dependencies.oidc || !dependencies.pool) {
      return unavailable(reply, 'OIDC and database configuration are required.')
    }

    const cookies = parseCookies(request.headers.cookie)
    if (!request.query.code || !request.query.state) {
      return reply.code(400).send({ error: 'invalid_callback' })
    }
    if (cookies.get(loginStateCookieName) !== request.query.state) {
      return reply.code(400).send({ error: 'invalid_callback_state' })
    }

    const loginState = await withTransaction(dependencies.pool, (client) =>
      consumeLoginState(client, request.query.state as string),
    )
    if (!loginState) return reply.code(400).send({ error: 'expired_callback' })

    const identity = await dependencies.oidc.exchangeCode(
      request.query.code,
      loginState,
    )
    const token = createOpaqueToken()
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000)
    await withTransaction(dependencies.pool, async (client) => {
      const member = await ensureMemberForIdentity(client, identity)
      await createSession(client, member.id, hashOpaqueToken(token), expiresAt)
    })

    reply.header('Set-Cookie', [
      serializeCookie(sessionCookieName, token, {
        maxAge: sessionTtlSeconds,
        secure: secureCookies(),
      }),
      serializeCookie(loginStateCookieName, '', {
        maxAge: 0,
        secure: secureCookies(),
      }),
    ])
    return reply.redirect('/')
  })

  app.post('/auth/logout', async (request, reply) => {
    if (dependencies.pool) {
      const token = parseCookies(request.headers.cookie).get(sessionCookieName)
      if (token) {
        await withTransaction(dependencies.pool, (client) =>
          deleteSession(client, hashOpaqueToken(token)),
        )
      }
    }
    reply.header(
      'Set-Cookie',
      serializeCookie(sessionCookieName, '', {
        maxAge: 0,
        secure: secureCookies(),
      }),
    )
    return reply.code(204).send()
  })

  app.get('/api/me', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    if (!member) return reply.code(401).send({ error: 'unauthenticated' })
    return { id: member.id, displayName: member.displayName, role: member.role, status: member.status }
  })

  app.get('/api/admin/members', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    if (!member) return reply.code(401).send({ error: 'unauthenticated' })
    assertActiveMember(member)
    if (member.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })

    const result = await dependencies.pool.query(
      `SELECT id, display_name AS "displayName", role, status
       FROM members ORDER BY display_name, id`,
    )
    return result.rows
  })

  app.get('/api/admin/audit', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertAdmin(member)
    return withTransaction(dependencies.pool, (client) => listAuditEntries(client))
  })

  app.get('/api/borrows', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    return withTransaction(dependencies.pool, (client) =>
      listBorrows(client, member.id, member.role === 'admin'),
    )
  })

  app.get<{ Params: { id: string } }>('/api/borrows/:id', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    const borrow = await withTransaction(dependencies.pool, (client) =>
      findBorrow(client, request.params.id),
    )
    if (!borrow || (member.role !== 'admin' && borrow.borrowerMemberId !== member.id)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return borrow
  })

  app.post<{
    Body: {
      deviceId: string
      borrowerMemberId?: string
      dueAt: string
      reason?: string
    }
  }>('/api/borrows', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    const idempotencyKey = request.headers['idempotency-key']
    const body = request.body
    if (
      typeof idempotencyKey !== 'string' ||
      !idempotencyKey ||
      !body ||
      typeof body.deviceId !== 'string' ||
      typeof body.dueAt !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_borrow_request' })
    }
    const borrowerMemberId = body.borrowerMemberId ?? member.id
    const reason = body.reason?.trim() ?? ''
    assertCanPerform('borrow', {
      actorId: member.id,
      actorRole: member.role,
      actorActive: member.status === 'active',
      responsibleMemberId: borrowerMemberId,
      reason,
    })
    const dueAt = new Date(body.dueAt)
    if (Number.isNaN(dueAt.getTime())) {
      return reply.code(400).send({ error: 'invalid_due_at' })
    }
    const result = await withTransaction(dependencies.pool, (client) =>
      borrowDevice(
        client,
        member.id,
        borrowerMemberId,
        body.deviceId,
        dueAt,
        idempotencyKey,
        hashRequest({
          deviceId: body.deviceId,
          borrowerMemberId,
          dueAt: body.dueAt,
          reason,
        }),
        reason,
      ),
    )
    return reply.code(result.replayed ? 200 : 201).send(result.record)
  })

  app.post<{
    Params: { id: string }
    Body: { returnNotes?: string }
  }>('/api/borrows/:id/return', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    const idempotencyKey = request.headers['idempotency-key']
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      return reply.code(400).send({ error: 'idempotency_key_required' })
    }
    const returnNotes = request.body?.returnNotes?.trim() ?? ''
    const result = await withTransaction(dependencies.pool, (client) =>
      returnBorrow(
        client,
        member.id,
        member.role === 'admin',
        request.params.id,
        returnNotes,
        idempotencyKey,
        hashRequest({ borrowId: request.params.id, returnNotes }),
      ),
    )
    return reply.code(200).send(result.record)
  })

  app.get('/api/reservations', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    return withTransaction(dependencies.pool, (client) =>
      listReservations(client, member.id, member.role === 'admin'),
    )
  })

  app.get<{ Params: { id: string } }>('/api/reservations/:id', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    const reservation = await withTransaction(dependencies.pool, (client) =>
      findReservation(client, request.params.id),
    )
    if (
      !reservation ||
      (member.role !== 'admin' && reservation.reserverMemberId !== member.id)
    ) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reservation
  })

  app.post<{
    Body: {
      deviceId: string
      reserverMemberId?: string
      startAt: string
      endAt: string
      reason?: string
    }
  }>('/api/reservations', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    const idempotencyKey = request.headers['idempotency-key']
    const body = request.body
    if (
      typeof idempotencyKey !== 'string' ||
      !idempotencyKey ||
      !body ||
      typeof body.deviceId !== 'string' ||
      typeof body.startAt !== 'string' ||
      typeof body.endAt !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_reservation_request' })
    }
    const reserverMemberId = body.reserverMemberId ?? member.id
    const reason = body.reason?.trim() ?? ''
    assertCanPerform('reserve', {
      actorId: member.id,
      actorRole: member.role,
      actorActive: member.status === 'active',
      responsibleMemberId: reserverMemberId,
      reason,
    })
    const startAt = new Date(body.startAt)
    const endAt = new Date(body.endAt)
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      return reply.code(400).send({ error: 'invalid_interval' })
    }
    const result = await withTransaction(dependencies.pool, (client) =>
      createReservation(
        client,
        member.id,
        reserverMemberId,
        body.deviceId,
        startAt,
        endAt,
        idempotencyKey,
        hashRequest({
          deviceId: body.deviceId,
          reserverMemberId,
          startAt: body.startAt,
          endAt: body.endAt,
          reason,
        }),
        reason,
      ),
    )
    return reply.code(result.replayed ? 200 : 201).send(result.record)
  })

  app.post<{ Params: { id: string } }>(
    '/api/reservations/:id/cancel',
    async (request, reply) => {
      if (!dependencies.pool) {
        return unavailable(reply, 'Database configuration is required.')
      }
      const member = await currentMember(request, dependencies.pool)
      assertActiveMember(member)
      const idempotencyKey = request.headers['idempotency-key']
      if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
        return reply.code(400).send({ error: 'idempotency_key_required' })
      }
      const result = await withTransaction(dependencies.pool, (client) =>
        cancelReservation(
          client,
          member.id,
          member.role === 'admin',
          request.params.id,
          idempotencyKey,
          hashRequest({ reservationId: request.params.id }),
        ),
      )
      return reply.code(200).send(result.record)
    },
  )

  app.get<{
    Params: { id: string }
    Querystring: { from?: string; to?: string }
  }>('/api/devices/:id/availability', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    const from = request.query.from ? new Date(request.query.from) : undefined
    const to = request.query.to ? new Date(request.query.to) : undefined
    if (
      (from && Number.isNaN(from.getTime())) ||
      (to && Number.isNaN(to.getTime()))
    ) {
      return reply.code(400).send({ error: 'invalid_interval' })
    }
    return withTransaction(dependencies.pool, (client) =>
      getAvailability(client, request.params.id, from, to),
    )
  })

  app.get('/api/devices', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    return withTransaction(dependencies.pool, (client) => listDevices(client))
  })

  app.get<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    const device = await withTransaction(dependencies.pool, (client) =>
      findDevice(client, request.params.id),
    )
    if (!device) return reply.code(404).send({ error: 'not_found' })
    return device
  })

  app.post<{ Body: CreateDeviceInput }>('/api/admin/devices', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    if (!member) return reply.code(401).send({ error: 'unauthenticated' })
    if (member.status !== 'active' || member.role !== 'admin') {
      await withTransaction(dependencies.pool, (client) =>
        appendAudit(client, {
          entityType: 'device_collection',
          entityId: 'devices',
          action: 'device.create',
          actorMemberId: member.id,
          reason: member.status === 'inactive' ? 'inactive_member' : 'forbidden',
          result: 'denied',
        }),
      )
      return reply.code(403).send({
        error: member.status === 'inactive' ? 'inactive_member' : 'forbidden',
      })
    }
    const body = request.body
    if (!body || typeof body.name !== 'string' || !body.name.trim()) {
      return reply.code(400).send({ error: 'invalid_device' })
    }
    const device = await withTransaction(dependencies.pool, (client) =>
      createDevice(client, member.id, {
        name: body.name.trim(),
        category: body.category?.trim(),
        serialNumber: body.serialNumber?.trim() || undefined,
        maintenanceNotes: body.maintenanceNotes?.trim(),
        attachmentNotes: body.attachmentNotes?.trim(),
      }),
    )
    return reply.code(201).send(device)
  })

  app.patch<{
    Params: { id: string }
    Body: UpdateDeviceInput & { reason?: string }
  }>('/api/admin/devices/:id', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertAdmin(member)
    const body = request.body ?? {}
    const allowedStatuses: DeviceStatus[] = [
      'available',
      'maintenance',
      'lost',
      'archived',
    ]
    if (body.status !== undefined && !allowedStatuses.includes(body.status)) {
      return reply.code(400).send({ error: 'invalid_device_status' })
    }
    const device = await withTransaction(dependencies.pool, (client) =>
      updateDevice(client, member.id, request.params.id, {
        ...body,
        name: body.name?.trim(),
        category: body.category?.trim(),
        serialNumber:
          body.serialNumber === undefined || body.serialNumber === null
            ? body.serialNumber
            : body.serialNumber.trim() || null,
        maintenanceNotes: body.maintenanceNotes?.trim(),
        attachmentNotes: body.attachmentNotes?.trim(),
        reason: body.reason?.trim(),
      }),
    )
    if (!device) return reply.code(404).send({ error: 'not_found' })
    return device
  })

  app.get('/api/notifications', async (request, reply) => {
    if (!dependencies.pool) {
      return unavailable(reply, 'Database configuration is required.')
    }
    const member = await currentMember(request, dependencies.pool)
    assertActiveMember(member)
    return withTransaction(dependencies.pool, (client) =>
      listNotifications(client, member.id, member.role === 'admin'),
    )
  })

  app.post<{ Params: { id: string } }>(
    '/api/notifications/:id/read',
    async (request, reply) => {
      if (!dependencies.pool) {
        return unavailable(reply, 'Database configuration is required.')
      }
      const member = await currentMember(request, dependencies.pool)
      assertActiveMember(member)
      const marked = await withTransaction(dependencies.pool, (client) =>
        markNotificationRead(client, member.id, member.role === 'admin', request.params.id),
      )
      if (!marked) return reply.code(404).send({ error: 'not_found' })
      return reply.code(204).send()
    },
  )

  return app
}
