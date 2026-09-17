import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'

const serverPort = '3101'
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
let testPool
let sessionToken = ''
let adminSessionToken = ''
let borrowDeviceName = ''
let reservationDeviceName = ''
let adminDeviceName = ''

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}

async function prepareAuthenticatedScenario() {
  if (!databaseUrl) return
  const env = { ...process.env, DATABASE_URL: databaseUrl }
  await runProcess(process.execPath, ['server-dist/server/src/migrate.js'], env)
  testPool = new Pool({ connectionString: databaseUrl })
  const suffix = randomUUID().slice(0, 8)
  const memberId = `e2e-member-${suffix}`
  const deviceId = `e2e-device-${suffix}`
  const reservationDeviceId = `e2e-reservation-device-${suffix}`
  const adminMemberId = `e2e-admin-${suffix}`
  borrowDeviceName = `E2E Camera ${suffix}`
  reservationDeviceName = `E2E Light ${suffix}`
  adminDeviceName = `E2E Admin Device ${suffix}`
  await testPool.query(
    `INSERT INTO members (id, identity_subject, display_name, role, status)
     VALUES ($1, $2, $3, 'member', 'active')`,
    [memberId, `e2e-subject-${suffix}`, `E2E Member ${suffix}`],
  )
  await testPool.query(
    `INSERT INTO devices (id, asset_number, name, category, status)
     VALUES ($1, $2, $3, 'E2E', 'available'), ($4, $5, $6, 'E2E', 'available')`,
    [deviceId, `E2E-${suffix}-1`, borrowDeviceName, reservationDeviceId, `E2E-${suffix}-2`, reservationDeviceName],
  )
  await testPool.query(
    `INSERT INTO members (id, identity_subject, display_name, role, status)
     VALUES ($1, $2, $3, 'admin', 'active')`,
    [adminMemberId, `e2e-admin-subject-${suffix}`, `E2E Admin ${suffix}`],
  )
  sessionToken = randomUUID()
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex')
  await testPool.query(
    `INSERT INTO sessions (id, member_id, token_hash, expires_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
    [randomUUID(), memberId, tokenHash],
  )
  adminSessionToken = randomUUID()
  const adminTokenHash = createHash('sha256').update(adminSessionToken).digest('hex')
  await testPool.query(
    `INSERT INTO sessions (id, member_id, token_hash, expires_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
    [randomUUID(), adminMemberId, adminTokenHash],
  )
}

await prepareAuthenticatedScenario()

const server = spawn(process.execPath, ['server-dist/server/src/main.js'], {
  env: { ...process.env, DATABASE_URL: databaseUrl ?? process.env.DATABASE_URL ?? '', HOST: '127.0.0.1', PORT: serverPort },
  stdio: 'inherit',
})
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5173'], {
  stdio: 'inherit',
})

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/healthz`)
      if (response.ok) return
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Server did not become healthy before E2E tests started.')
}

async function waitForWeb() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:5173/')
      if (response.ok) return
    } catch {
      // The preview may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Frontend preview did not start before E2E tests began.')
}

function stopServer() {
  if (server.exitCode === null) server.kill()
  if (web.exitCode === null) web.kill()
}

try {
  await waitForServer()
  await waitForWeb()
  const playwright = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test'],
    { env: { ...process.env, E2E_SESSION_TOKEN: sessionToken, E2E_ADMIN_SESSION_TOKEN: adminSessionToken, E2E_BORROW_DEVICE: borrowDeviceName, E2E_RESERVATION_DEVICE: reservationDeviceName, E2E_ADMIN_DEVICE: adminDeviceName }, stdio: 'inherit' },
  )

  const exitCode = await new Promise((resolve) => {
    playwright.on('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = exitCode
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  stopServer()
  await testPool?.end()
}
