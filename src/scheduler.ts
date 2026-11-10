import { setTimeout as delay } from 'node:timers/promises'
import { claim, finish, infraFailure, reclaim } from './jobs.ts'
import { db } from './db.ts'
import type { Evidence } from './runner.ts'

const slots = Number(process.env.JUDGE_SLOTS ?? 2)
const leaseMs = Number(process.env.LEASE_MS ?? 12000)
const executor = process.env.EXECUTOR_URL
const key = process.env.EXECUTOR_KEY ?? ''
if (!executor || key.length < 32 || !Number.isInteger(slots) || slots < 1 || slots > 4 ||
    !Number.isInteger(leaseMs) || leaseMs < 8000 || leaseMs > 60000) throw new Error('Invalid scheduler config')

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true })
const allowed = new Set(['ALL_PASS','ASSERTION_MISMATCH','SUT_RUNTIME_ERROR','INFRA_FAILURE','TIMEOUT'])
console.log('Scheduler ready', { slots, leaseMs })

async function worker(slot: number) {
  while (!stopping) {
    try {
      if (!slot) await reclaim()
      const task = await claim(leaseMs)
      if (!task) { await delay(150); continue }
      let evidence: Evidence = infraFailure
      try {
        const response = await fetch(executor + '/execute', {
          method: 'POST', signal: AbortSignal.timeout(6500),
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({
            taskId: task.id, fence: task.fence, packHash: task.pack_hash, variant: task.variant,
            suite: task.suite, preview: task.mode === 'PREVIEW'
          })
        })
        if (!response.ok) throw new Error('Executor status ' + response.status)
        const result = await response.json()
        if (result.taskId !== task.id || result.fence !== task.fence || result.packHash !== task.pack_hash ||
            result.variant !== task.variant || !allowed.has(result.outcome) ||
            (result.outcome === 'ASSERTION_MISMATCH' && (!result.failure?.testId || result.exitCode !== 0))) {
          throw new Error('Invalid executor evidence')
        }
        evidence = {
          outcome: result.outcome, durationMs: result.durationMs, exitCode: result.exitCode,
          signal: result.signal, failure: result.failure, results: result.results
        }
      } catch (error: any) {
        console.error('Attempt unavailable', { task: task.id, fence: task.fence, reason: error.message })
      }
      await finish(task, evidence)
    } catch (error: any) {
      console.error('Scheduler loop failed', error.message)
      await delay(600)
    }
  }
}
await Promise.all(Array.from({ length: slots }, (_, i) => worker(i)))
await db.end()
