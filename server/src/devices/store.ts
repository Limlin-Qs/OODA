import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { appendAudit } from '../audit/store.js'
import { DomainRuleError, transitionDevice, type DeviceStatus } from '../domain/rules.js'

export interface Device {
  id: string
  assetNumber: string
  serialNumber: string | null
  name: string
  category: string
  status: DeviceStatus
  maintenanceNotes: string
  attachmentNotes: string
  createdAt: Date
  updatedAt: Date
}

export interface CreateDeviceInput {
  name: string
  category?: string
  serialNumber?: string
  maintenanceNotes?: string
  attachmentNotes?: string
}

export interface UpdateDeviceInput {
  name?: string
  category?: string
  serialNumber?: string | null
  status?: DeviceStatus
  maintenanceNotes?: string
  attachmentNotes?: string
  reason?: string
}

interface DeviceRow {
  id: string
  asset_number: string
  serial_number: string | null
  name: string
  category: string
  status: DeviceStatus
  maintenance_notes: string
  attachment_notes: string
  created_at: Date
  updated_at: Date
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    assetNumber: row.asset_number,
    serialNumber: row.serial_number,
    name: row.name,
    category: row.category,
    status: row.status,
    maintenanceNotes: row.maintenance_notes,
    attachmentNotes: row.attachment_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const deviceColumns = `
  id, asset_number, serial_number, name, category, status,
  maintenance_notes, attachment_notes, created_at, updated_at
`

export async function listDevices(client: PoolClient): Promise<Device[]> {
  const result = await client.query<DeviceRow>(
    `SELECT ${deviceColumns} FROM devices ORDER BY name, asset_number`,
  )
  return result.rows.map(toDevice)
}

export async function findDevice(
  client: PoolClient,
  id: string,
): Promise<Device | null> {
  const result = await client.query<DeviceRow>(
    `SELECT ${deviceColumns} FROM devices WHERE id = $1`,
    [id],
  )
  return result.rows[0] ? toDevice(result.rows[0]) : null
}

function nextAssetNumber(): string {
  return `EQ-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
}

export async function createDevice(
  client: PoolClient,
  actorMemberId: string,
  input: CreateDeviceInput,
): Promise<Device> {
  const id = randomUUID()
  const result = await client.query<DeviceRow>(
    `INSERT INTO devices
      (id, asset_number, serial_number, name, category, status,
       maintenance_notes, attachment_notes)
     VALUES ($1, $2, $3, $4, $5, 'available', $6, $7)
     RETURNING ${deviceColumns}`,
    [
      id,
      nextAssetNumber(),
      input.serialNumber ?? null,
      input.name,
      input.category ?? '',
      input.maintenanceNotes ?? '',
      input.attachmentNotes ?? '',
    ],
  )
  const device = toDevice(result.rows[0])
  await appendAudit(client, {
    entityType: 'device',
    entityId: device.id,
    action: 'device.created',
    actorMemberId,
    afterState: { status: device.status, assetNumber: device.assetNumber },
    result: 'success',
  })
  return device
}

export async function updateDevice(
  client: PoolClient,
  actorMemberId: string,
  id: string,
  input: UpdateDeviceInput,
): Promise<Device | null> {
  const current = await findDevice(client, id)
  if (!current) return null
  const nextStatus = input.status ?? current.status
  if (input.status && input.status !== current.status) {
    if (!input.reason?.trim()) {
      throw new DomainRuleError(
        'missing_reason',
        'A reason is required when changing a device status.',
      )
    }
    transitionDevice(current.status, input.status)
  }
  const result = await client.query<DeviceRow>(
    `UPDATE devices SET
      name = $2,
      category = $3,
      serial_number = $4,
      status = $5,
      maintenance_notes = $6,
      attachment_notes = $7,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${deviceColumns}`,
    [
      id,
      input.name ?? current.name,
      input.category ?? current.category,
      input.serialNumber === undefined ? current.serialNumber : input.serialNumber,
      nextStatus,
      input.maintenanceNotes ?? current.maintenanceNotes,
      input.attachmentNotes ?? current.attachmentNotes,
    ],
  )
  const device = toDevice(result.rows[0])
  await appendAudit(client, {
    entityType: 'device',
    entityId: device.id,
    action: 'device.updated',
    actorMemberId,
    beforeState: { status: current.status, assetNumber: current.assetNumber },
    afterState: { status: device.status, assetNumber: device.assetNumber },
    reason: input.reason?.trim() ?? '',
    result: 'success',
  })
  return device
}
