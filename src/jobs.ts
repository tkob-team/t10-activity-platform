import type { PoolClient } from 'pg'
import { audit, db, revise, tx } from './db.ts'
import { loadPack } from './pack.ts'
import type { Evidence } from './runner.ts'

const pack = loadPack()
export const variants = Object.keys(pack.variants)
const maxAttempts = 2

type Task = {
  id: string, fence: number, variant: string, attempt: number, room_id: string,
  submission_id: string, entrant_id: string, mode: string, suite: unknown, pack_hash: string
}

export async function claim(leaseMs: number): Promise<Task | undefined> {
  return tx(async client => {
    const { rows } = await client.query(
      `WITH next AS (
        SELECT t.id FROM tasks t JOIN submissions s ON s.id=t.submission_id
        JOIN rooms r ON r.id=s.room_id
        WHERE t.status='QUEUED' AND t.ready_at<=clock_timestamp()
          AND r.state IN ('OPEN','PAUSED','CLOSED') AND r.pack_hash=$2
        ORDER BY s.mode='PREVIEW',
          (SELECT count(*) FROM tasks a JOIN submissions p ON p.id=a.submission_id
            WHERE p.entrant_id=s.entrant_id AND a.status='LEASED'),
          t.variant<>'', t.id
        FOR UPDATE OF t SKIP LOCKED LIMIT 1
      )
      UPDATE tasks t SET status='LEASED',attempt=t.attempt+1,fence=t.fence+1,
        lease_until=clock_timestamp()+$1::integer*interval '1 millisecond'
      FROM next,submissions s,rooms r
      WHERE t.id=next.id AND s.id=t.submission_id AND r.id=s.room_id
      RETURNING t.id,t.fence,t.variant,t.attempt,t.submission_id,s.room_id,s.entrant_id,s.mode,s.suite,r.pack_hash`,
      [leaseMs, pack.id])
    const task = rows[0]
    if (task) await client.query('INSERT INTO attempts(task_id,fence) VALUES($1,$2)', [task.id, task.fence])
    return task
  })
}

export async function refreshSubmission(client: PoolClient, id: string) {
  await client.query(`UPDATE submissions s SET status=CASE
    WHEN EXISTS (SELECT 1 FROM tasks WHERE submission_id=s.id AND status IN ('QUEUED','LEASED')) THEN 'EVALUATING'
    WHEN EXISTS (SELECT 1 FROM tasks WHERE submission_id=s.id AND status='INCONCLUSIVE') THEN 'REVIEW_REQUIRED'
    ELSE 'GRADED' END WHERE s.id=$1`, [id])
}

export async function finish(task: Task, evidence: Evidence, expired = false): Promise<void> {
  await tx(async client => {
    const { rows: [room] } = await client.query('SELECT state FROM rooms WHERE id=$1 FOR UPDATE', [task.room_id])
    if (!room || ['FINALIZED','ARCHIVED'].includes(room.state)) return
    const { rows } = await client.query(
      `SELECT id FROM tasks WHERE id=$1 AND status='LEASED' AND fence=$2
       AND CASE WHEN $3::boolean THEN lease_until<=clock_timestamp() ELSE lease_until>clock_timestamp() END
       FOR UPDATE`, [task.id, task.fence, expired])
    if (!rows.length) return
    const data = { ...evidence, expired, packHash: task.pack_hash }
    await client.query('UPDATE attempts SET finished_at=clock_timestamp(),evidence=$3 WHERE task_id=$1 AND fence=$2',
      [task.id, task.fence, data])
    const retryable = evidence.outcome === 'INFRA_FAILURE' || evidence.outcome === 'TIMEOUT'
    if (retryable && task.attempt < maxAttempts) {
      await client.query(`UPDATE tasks SET status='QUEUED',lease_until=NULL,
        ready_at=clock_timestamp()+interval '600 milliseconds',evidence=$2 WHERE id=$1`, [task.id, data])
      return
    }

    const verdict = evidence.outcome === 'ALL_PASS' ? (task.variant ? 'SURVIVED' : 'PASSED')
      : evidence.outcome === 'ASSERTION_MISMATCH' ? (task.variant ? 'KILLED' : 'ORIGINAL_FAILED') : 'INCONCLUSIVE'
    await client.query('UPDATE tasks SET status=$2,evidence=$3,lease_until=NULL WHERE id=$1', [task.id, verdict, data])
    if (!task.variant) {
      const status = task.mode === 'PREVIEW' ? 'PREVIEWED'
        : verdict === 'PASSED' ? 'EVALUATING' : verdict === 'ORIGINAL_FAILED' ? 'ORIGINAL_FAILED' : 'REVIEW_REQUIRED'
      await client.query('UPDATE submissions SET original=$2,status=$3 WHERE id=$1', [task.submission_id, data, status])
      if (status === 'EVALUATING') {
        await client.query(`INSERT INTO tasks(submission_id,variant)
          SELECT $1,v FROM unnest($2::text[]) AS v
          WHERE NOT EXISTS (SELECT 1 FROM exclusions WHERE room_id=$3 AND variant=v)
          AND NOT EXISTS (SELECT 1 FROM awards WHERE room_id=$3 AND entrant_id=$4 AND variant=v AND revoked_at IS NULL)
          ON CONFLICT DO NOTHING`, [task.submission_id, variants, task.room_id, task.entrant_id])
        await refreshSubmission(client, task.submission_id)
      }
      return
    }
    if (verdict === 'KILLED') {
      const { rowCount } = await client.query(
        `INSERT INTO awards(room_id,entrant_id,variant,task_id)
         SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM exclusions WHERE room_id=$1 AND variant=$3)
         ON CONFLICT DO NOTHING`, [task.room_id, task.entrant_id, task.variant, task.id])
      if (rowCount) {
        await revise(client, task.room_id)
        await audit(client, task.room_id, 'AWARDED', { submissionId: task.submission_id, variant: task.variant, fence: task.fence })
      }
    }
    await refreshSubmission(client, task.submission_id)
  })
}

export const infraFailure: Evidence = { outcome: 'INFRA_FAILURE', durationMs: 0, exitCode: null, signal: null }
export async function reclaim() {
  const { rows } = await db.query(
    `SELECT t.id,t.fence,t.variant,t.attempt,t.submission_id,s.room_id,s.entrant_id,s.mode,r.pack_hash
    FROM tasks t JOIN submissions s ON s.id=t.submission_id JOIN rooms r ON r.id=s.room_id
    WHERE t.status='LEASED' AND t.lease_until<=clock_timestamp()
      AND r.state IN ('OPEN','PAUSED','CLOSED') LIMIT 20`)
  for (const task of rows) await finish(task, infraFailure, true)
}
