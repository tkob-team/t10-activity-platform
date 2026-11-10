import pg from 'pg'
import type { PoolClient } from 'pg'

export const db = new pg.Pool({ max: 8, connectionTimeoutMillis: 3000 })
db.on('error', error => console.error('Database idle connection error', error.message))

export async function tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const value = await run(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function audit(client: PoolClient, room: string, action: string, details: object = {}) {
  await client.query('INSERT INTO audit(room_id,action,details) VALUES($1,$2,$3)', [room, action, details])
}

export async function revise(client: PoolClient, room: string) {
  await client.query('UPDATE rooms SET revision=revision+1 WHERE id=$1', [room])
}
