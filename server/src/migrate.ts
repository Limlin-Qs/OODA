import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'

const migrationsDirectory = join(process.cwd(), 'server', 'migrations')

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true })

  return entries
    .filter((entry) => entry.isFile() && /^\d{4}-.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

async function migrate(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _sharework_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const migration of await listMigrations()) {
      await client.query('BEGIN')

      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('sharework:schema-migrations'))",
        )
        const result = await client.query<{ version: string }>(
          'SELECT version FROM _sharework_schema_migrations WHERE version = $1',
          [migration],
        )

        if (result.rowCount === 0) {
          const sql = await readFile(join(migrationsDirectory, migration), 'utf8')
          await client.query(sql)
          await client.query(
            'INSERT INTO _sharework_schema_migrations (version) VALUES ($1)',
            [migration],
          )
          console.log(`Applied ${migration}`)
        }

        await client.query('COMMIT')
      } catch (error: unknown) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    client.release()
    await pool.end()
  }
}

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('DATABASE_URL is required to run migrations.')
  process.exitCode = 1
} else {
  migrate(databaseUrl).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
