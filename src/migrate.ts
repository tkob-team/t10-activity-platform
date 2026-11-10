import { readFileSync, readdirSync } from 'node:fs'
import { sha } from './pack.ts'
import { db, tx } from './db.ts'

const directory = new URL('../db/', import.meta.url)
const files = readdirSync(directory).filter(file => /^\d{3}-[a-z-]+\.sql$/.test(file)).sort()
try {
  await tx(async client => {
    await client.query('SELECT pg_advisory_xact_lock(465017)')
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, sha256 text NOT NULL)')
    for (const file of files) {
      const version = Number(file.slice(0, 3))
      const schema = readFileSync(new URL(file, directory), 'utf8')
      const { rows: [applied] } = await client.query('SELECT sha256 FROM schema_migrations WHERE version=$1', [version])
      if (applied) {
        if (applied.sha256 !== sha(schema)) throw new Error('Applied migration checksum mismatch: ' + file)
        continue
      }
      await client.query(schema)
      await client.query('INSERT INTO schema_migrations VALUES ($1,$2)', [version, sha(schema)])
    }
  })
  console.log('Schema ready')
} finally {
  await db.end()
}
