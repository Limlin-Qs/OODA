import { buildApp } from './app.js'
import { OidcClient, readOidcConfig } from './auth/oidc.js'
import { Pool } from 'pg'
import { runOverdueReminderCycle } from './notifications/store.js'

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : undefined
const oidcConfig = readOidcConfig(process.env)
const app = buildApp({
  pool,
  oidc: oidcConfig ? new OidcClient(oidcConfig) : undefined,
})
const port = Number(process.env.PORT ?? '4016')
const host = process.env.HOST ?? '127.0.0.1'

app.listen({ port, host }).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

const reminderInterval = pool
  ? setInterval(() => {
      void runOverdueReminderCycle(pool).catch((error: unknown) => console.error(error))
    }, 60_000)
  : undefined

async function shutdown(): Promise<void> {
  if (reminderInterval) clearInterval(reminderInterval)
  await app.close()
  await pool?.end()
}

process.once('SIGINT', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})
