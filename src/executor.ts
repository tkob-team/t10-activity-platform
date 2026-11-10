import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { loadPack, sha } from './pack.ts'
import { runVariant } from './runner.ts'
import { prepareSuite } from './submission.mjs'

const app = express()
const pack = loadPack()
const token = process.env.EXECUTOR_KEY ?? ''
if (token.length < 32) throw new Error('Missing executor key')
const slots = Number(process.env.JUDGE_SLOTS ?? 2)
if (!Number.isInteger(slots) || slots < 1 || slots > 4) throw new Error('JUDGE_SLOTS must be 1..4')
let active = 0

app.disable('x-powered-by')
app.get('/health', (_request, response) => response.json({ ready: true }))
app.use(express.json({ limit: '64kb' }))
app.post('/execute', async (request, response) => {
  if (!timingSafeEqual(Buffer.from(sha(request.get('authorization') || '')), Buffer.from(sha('Bearer ' + token)))) {
    return response.sendStatus(401)
  }
  if (active >= slots) return response.sendStatus(429)
  const { taskId, fence, packHash, variant, suite, preview } = request.body ?? {}
  if (typeof taskId !== 'string' || !/^[1-9]\d*$/.test(taskId) || !Number.isSafeInteger(fence) || fence < 1 ||
      typeof variant !== 'string' || typeof preview !== 'boolean' ||
      packHash !== pack.id || (variant !== '' && !Object.hasOwn(pack.variants, variant))) return response.sendStatus(422)
  let normalized
  try { normalized = prepareSuite({ builder: suite, code: '' }, { operationSet: pack.operations, scenarioSet: pack.scenarios, preview }) }
  catch { return response.sendStatus(422) }
  active++
  try {
    const evidence = await runVariant(variant || null, normalized, 4500, pack.id)
    response.json({ taskId, fence, packHash, variant, ...evidence })
  } finally {
    active--
  }
})
app.listen(8789, '0.0.0.0', () => console.log('Executor ready', pack.id))
