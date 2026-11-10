import express from 'express'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { audit, db, revise, tx } from './db.ts'
import { canonical, loadPack, publicPack, sha } from './pack.ts'
import { refreshSubmission } from './jobs.ts'
import { prepareSuite } from './submission.mjs'

const pack = loadPack()
const adminKey = process.env.ADMIN_KEY ?? ''
const origin = process.env.PUBLIC_ORIGIN || ''
const publicPort = process.env.PUBLIC_PORT || '8787'
const adminPort = process.env.ADMIN_PORT || '8788'
const publicOrigin = origin || 'http://127.0.0.1:' + publicPort
const directory = fileURLToPath(new URL('../public/', import.meta.url))
const publicData = publicPack(pack)
if (adminKey.length < 32) throw new Error('Missing host key')
if (origin && new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN must be an exact origin')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const latest = "(SELECT id FROM rooms ORDER BY opened_at DESC LIMIT 1)"
const live = "(SELECT id FROM rooms WHERE id=" + latest + " AND state<>'ARCHIVED')"

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
function reject(status: number, message: string): never { throw new HttpError(status, message) }
function label(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    reject(422, 'Tên hoặc lý do chưa hợp lệ.')
  }
  return value.trim()
}
const secret = () => randomBytes(24).toString('hex')
const cookie = { httpOnly: true, sameSite: 'strict' as const, maxAge: 8 * 3600000, path: '/' }

function base(port: number, hostPort: string, configuredOrigin = '') {
  const origins = ['http://127.0.0.1:' + hostPort, 'http://localhost:' + hostPort]
  if (configuredOrigin) origins.push(configuredOrigin)
  const byHost = new Map(origins.map(url => [new URL(url).host, url]))
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    const nonce = randomBytes(18).toString('base64')
    res.locals.styleNonce = nonce
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'nonce-" + nonce + "'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    })
    if (!['GET', 'HEAD'].includes(req.method)) {
      const source = req.get('origin')
      const expected = byHost.get(req.get('host')?.toLowerCase() ?? '')
      if (!expected || (source && source !== expected) || req.get('sec-fetch-site') === 'cross-site') {
        return next(new HttpError(403, 'Nguồn yêu cầu không hợp lệ.'))
      }
      if (!req.is('application/json')) return next(new HttpError(415, 'Yêu cầu JSON.'))
      res.locals.secureSession = expected.startsWith('https://')
    }
    next()
  })
  app.use(express.json({ limit: '48kb' }))
  app.get('/health', async (_req, res) => {
    await db.query('SELECT 1')
    res.json({ ready: true, port, packHash: pack.id })
  })
  return app
}
function catchErrors(app: ReturnType<typeof express>) {
  app.use((_req, res) => res.status(404).json({ error: 'Không tìm thấy.' }))
  app.use((error: any, _req: any, res: any, _next: any) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message })
    if (error.code === '23505') return res.status(409).json({ error: 'Tên đã dùng hoặc còn lượt đang chấm.' })
    if (error.status === 400 || error.status === 413) return res.status(error.status).json({ error: 'JSON không hợp lệ hoặc quá lớn.' })
    console.error('Request failed', error.code ?? error.name)
    res.status(503).json({ error: 'Máy chủ chưa xử lý được. Vui lòng thử lại.' })
  })
}
function limit(max: number) {
  let windowStart = Date.now()
  const counts = new Map<string, number>()
  return (req: any, res: any, next: any) => {
    if (Date.now() - windowStart >= 60000) { counts.clear(); windowStart = Date.now() }
    const ip = req.ip ?? ''
    if (!counts.has(ip) && counts.size >= 3000) return res.sendStatus(429)
    const hits = (counts.get(ip) ?? 0) + 1
    counts.set(ip, hits)
    if (hits > max) return res.status(429).json({ error: 'Nhiều lượt yêu cầu. Thử lại sau.' })
    next()
  }
}
function page(app: ReturnType<typeof express>, route: string, file: string) {
  app.get(route, (_req, res) => res.sendFile(file, { root: directory }))
}

async function ranking(roomId: string) {
  const { rows } = await db.query(`SELECT r.id AS "roomId",r.title,r.state,r.revision,
    COALESCE(jsonb_agg(to_jsonb(ranked) ORDER BY ranked.rank,ranked.name) FILTER (WHERE ranked.name IS NOT NULL),'[]') AS teams
    FROM rooms r LEFT JOIN LATERAL (
      SELECT e.name,count(a.variant)::int AS score,rank() OVER(ORDER BY count(a.variant) DESC)::int AS rank
      FROM entrants e LEFT JOIN awards a ON a.entrant_id=e.id AND a.revoked_at IS NULL
      WHERE e.room_id=r.id GROUP BY e.id
    ) ranked ON true WHERE r.id=$1 GROUP BY r.id`, [roomId])
  return rows[0]
}

const publicApp = base(8787, publicPort, origin)
const participantPage = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
publicApp.get('/', (_req, res) => res.type('html').send(participantPage.replace('EDITOR_STYLE_NONCE', res.locals.styleNonce)))
page(publicApp, '/projector', 'projector.html')
for (const file of ['styles.css','app.js','builder.js','ranking.js','results.js','editor.js']) page(publicApp, '/' + file, file)
publicApp.get('/api/room', async (_req, res) => {
  const { rows } = await db.query('SELECT title,state,opened_at FROM rooms WHERE id=' + live)
  res.json(rows[0] ?? { state: 'WAITING' })
})
async function latestRanking() {
  const { rows } = await db.query('SELECT id FROM rooms WHERE id=' + live)
  return rows[0] ? await ranking(rows[0].id) : { state: 'WAITING', teams: [] }
}
publicApp.get('/api/ranking', async (_req, res) => res.json(await latestRanking()))
const listeners = new Set<any>()
let lastRanking = ''
let broadcasting = false
setInterval(async () => {
  if (!listeners.size || broadcasting) return
  broadcasting = true
  try {
    const current = JSON.stringify(await latestRanking())
    const message = current === lastRanking ? ': heartbeat\n\n' : 'event: ranking\ndata: ' + current + '\n\n'
    lastRanking = current
    for (const listener of listeners) {
      if (!listener.write(message)) listener.end()
    }
  } catch {
    for (const listener of listeners) listener.end()
  } finally { broadcasting = false }
}, 1000).unref()
publicApp.get('/api/ranking/events', async (_req, res) => {
  if (listeners.size >= 100) reject(503, 'Đang bận. Dùng bản cập nhật bảng điểm.')
  const current = JSON.stringify(await latestRanking())
  res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform' })
  res.flushHeaders()
  res.write('event: ranking\ndata: ' + current + '\n\n')
  listeners.add(res)
  res.once('close', () => listeners.delete(res))
})
publicApp.post('/api/join', limit(100), async (req, res) => {
  const name = label(req.body?.name, 50)
  const session = secret()
  const entrant = await tx(async client => {
    const { rows: [room] } = await client.query('SELECT * FROM rooms WHERE id=' + live + ' FOR UPDATE')
    if (room?.state !== 'OPEN') reject(409, 'Phòng chưa mở nhận người chơi.')
    const id = randomUUID()
    await client.query('INSERT INTO entrants(id,room_id,name,session_hash,recovery_hash) VALUES($1,$2,$3,$4,$5)',
      [id, room.id, name, sha(session), sha(secret())])
    await revise(client, room.id)
    return { id, name, room: room.id }
  })
  res.cookie('lab_session', session, { ...cookie, secure: res.locals.secureSession }).status(201).json(entrant)
})
publicApp.post('/api/recover', limit(60), async (req, res) => {
  const previous = req.body?.recovery
  if (typeof previous !== 'string' || !/^[0-9a-f]{48}$/.test(previous)) reject(422, 'Mã khôi phục sai định dạng.')
  const session = secret()
  const { rows: [entrant] } = await db.query(
    `UPDATE entrants SET session_hash=$1,recovery_hash=$2,recovery_expires_at=NULL
      WHERE recovery_hash=$3 AND recovery_expires_at>clock_timestamp() AND room_id=${live}
      RETURNING id,name,room_id AS room`, [sha(session), sha(secret()), sha(previous)])
  if (!entrant) reject(403, 'Liên kết đã hết hiệu lực. Nhờ điều phối viên cấp lại.')
  res.cookie('lab_session', session, { ...cookie, secure: res.locals.secureSession }).json(entrant)
})

publicApp.use('/api', async (req, res, next) => {
  const session = /(?:^|;\s*)lab_session=([0-9a-f]{48})(?:;|$)/.exec(req.get('cookie') || '')?.[1]
  if (!session) reject(401, 'Vào phòng để tiếp tục.')
  const { rows: [entrant] } = await db.query(
    `SELECT e.id,e.name,e.room_id AS room FROM entrants e JOIN rooms r ON r.id=e.room_id
     WHERE e.session_hash=$1 AND e.room_id=${live} AND r.opened_at > now()-interval '8 hours'`, [sha(session)])
  if (!entrant) reject(401, 'Phiên đã hết hiệu lực. Liên hệ điều phối viên để vào lại.')
  res.locals.entrant = entrant
  next()
})
publicApp.get('/api/session', (_req, res) => res.json(res.locals.entrant))
publicApp.get('/api/activity', (_req, res) => res.json(publicData))
const packPoints = Object.keys(pack.variants).length
publicApp.get('/api/score', async (_req, res) => {
  const { id, room } = res.locals.entrant
  const { rows: [score] } = await db.query(`SELECT
    (SELECT count(*)::int FROM awards WHERE room_id=$1 AND entrant_id=$2 AND revoked_at IS NULL) AS points,
    $3::int - (SELECT count(*)::int FROM exclusions WHERE room_id=$1) AS "maxPoints"`, [room, id, packPoints])
  res.json(score)
})

const submissionStatus = `CASE WHEN s.status='QUEUED' AND EXISTS(
  SELECT 1 FROM tasks WHERE submission_id=s.id AND variant='' AND status='LEASED')
  THEN 'VERIFYING_ORIGINAL' ELSE s.status END`
const variantProgress = `(SELECT jsonb_build_object('total',count(*),'killed',count(*) FILTER(WHERE status='KILLED'),
  'survived',count(*) FILTER(WHERE status='SURVIVED'),'inconclusive',count(*) FILTER(WHERE status='INCONCLUSIVE'),
  'pending',count(*) FILTER(WHERE status IN ('QUEUED','LEASED')))
  FROM tasks WHERE submission_id=s.id AND variant<>'')`
const resultSql = `SELECT s.id,s.mode,${submissionStatus} AS status,
  s.accepted_at AS "acceptedAt",s.original,
  (SELECT count(*)::int FROM awards a JOIN tasks t ON t.id=a.task_id
    WHERE t.submission_id=s.id AND a.revoked_at IS NULL) AS "newPoints",
  ${variantProgress} AS progress FROM submissions s`
publicApp.get('/api/submissions', async (_req, res) => {
  const { rows } = await db.query(resultSql + " WHERE entrant_id=$1 AND mode='SCORE' ORDER BY accepted_at DESC LIMIT 30", [res.locals.entrant.id])
  res.json(rows)
})
publicApp.get('/api/submissions/:id', async (req, res) => {
  if (!uuid.test(req.params.id)) reject(404, 'Không tìm thấy lượt nộp.')
  const { rows: [job] } = await db.query(resultSql + " WHERE s.id=$1 AND entrant_id=$2 AND mode='SCORE'", [req.params.id, res.locals.entrant.id])
  if (!job) reject(404, 'Không tìm thấy lượt nộp.')
  res.json(job)
})
publicApp.post('/api/submissions', limit(240), async (req, res) => {
  const entrant = res.locals.entrant
  const key = req.get('idempotency-key') ?? ''
  const { mode, packHash, builder, code } = req.body ?? {}
  if (!uuid.test(key) || mode !== 'SCORE' || packHash !== pack.id) reject(422, 'Yêu cầu nộp không hợp lệ. Tải lại trang nếu cần.')
  if (!Array.isArray(builder) || typeof code !== 'string' || Boolean(builder.length) === Boolean(code.trim())) {
    reject(422, 'Nộp một bộ test từ tab đang mở.')
  }
  let suite
  try { suite = prepareSuite({ builder, code }, { operationSet: pack.operations, scenarioSet: pack.scenarios }) }
  catch (error: any) { reject(422, error.message) }
  const fingerprint = sha(canonical({ mode, suite }))
  const receipt = await tx(async client => {
    const { rows: [room] } = await client.query('SELECT state,pack_hash FROM rooms WHERE id=$1 FOR UPDATE', [entrant.room])
    const { rows: [previous] } = await client.query(
      'SELECT id,status,accepted_at AS "acceptedAt",fingerprint FROM submissions WHERE entrant_id=$1 AND idempotency_key=$2',
      [entrant.id, key])
    if (previous) {
      if (previous.fingerprint !== fingerprint) reject(409, 'Khóa gửi lại đã dùng với bài khác.')
      const { fingerprint: _fingerprint, ...saved } = previous
      return saved
    }
    if (room?.state !== 'OPEN' || room.pack_hash !== packHash) reject(409, 'Phòng đang dừng hoặc đã đóng.')
    const { rows: [job] } = await client.query(
      `INSERT INTO submissions(id,room_id,entrant_id,idempotency_key,fingerprint,suite,mode,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'QUEUED') RETURNING id,status,accepted_at AS "acceptedAt"`,
      [randomUUID(), entrant.room, entrant.id, key, fingerprint, JSON.stringify(suite), mode])
    await client.query("INSERT INTO tasks(submission_id,variant) VALUES($1,'')", [job.id])
    return job
  })
  res.status(202).json(receipt)
})
catchErrors(publicApp)

const host = base(8788, adminPort)
page(host, '/', 'admin.html')
page(host, '/styles.css', 'styles.css')
page(host, '/admin.js', 'admin.js')
page(host, '/results.js', 'results.js')
page(host, '/builder.js', 'builder.js')
host.use('/api', limit(240), (req, _res, next) => {
  const supplied = req.get('authorization') || ''
  if (!timingSafeEqual(Buffer.from(sha(supplied)), Buffer.from(sha('Bearer ' + adminKey)))) reject(401, 'Khóa điều phối không hợp lệ.')
  next()
})

async function roomSummary() {
  const { rows: [room] } = await db.query(`SELECT r.id,r.title,r.state,r.revision,r.pack_hash,
    count(t.id) FILTER(WHERE t.status IN ('QUEUED','LEASED'))::int AS pending,
    count(t.id) FILTER(WHERE t.status='INCONCLUSIVE' AND s.mode='SCORE')::int AS inconclusive
    FROM rooms r LEFT JOIN submissions s ON s.room_id=r.id LEFT JOIN tasks t ON t.submission_id=s.id
    WHERE r.id=${live} GROUP BY r.id`)
  return room ?? { state: 'WAITING' }
}
host.get('/api/host', async (_req, res) => {
  const room = await roomSummary()
  const { rows } = await db.query(`SELECT t.id,s.id AS "submissionId",e.name,t.variant,t.attempt,t.evidence
    FROM tasks t JOIN submissions s ON s.id=t.submission_id JOIN entrants e ON e.id=s.entrant_id
    WHERE s.room_id=$1 AND t.status='INCONCLUSIVE' AND s.mode='SCORE' ORDER BY t.id LIMIT 50`, [room.id ?? null])
  const { rows: teams } = await db.query(`SELECT e.id,e.name,
    (SELECT count(*)::int FROM awards WHERE entrant_id=e.id AND revoked_at IS NULL) AS points,
    count(s.id)::int AS submissions,
    count(s.id) FILTER(WHERE s.status IN ('QUEUED','VERIFYING_ORIGINAL','EVALUATING'))::int AS active,
    count(s.id) FILTER(WHERE s.status='REVIEW_REQUIRED')::int AS flagged,
    max(s.accepted_at) AS "lastSubmission"
    FROM entrants e LEFT JOIN submissions s ON s.entrant_id=e.id AND s.mode='SCORE'
    WHERE e.room_id=$1 GROUP BY e.id ORDER BY points DESC, e.name`, [room.id ?? null])
  const { rows: [archive] } = await db.query("SELECT id,title FROM rooms WHERE state='ARCHIVED' ORDER BY opened_at DESC LIMIT 1")
  res.json({ ...room, review: rows, teams, archive, publicOrigin })
})
host.get('/api/host/teams/:id', async (req, res) => {
  if (!uuid.test(req.params.id)) reject(404, 'Không tìm thấy người tham gia.')
  const page = Number(req.query.page ?? 1)
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) reject(422, 'Trang không hợp lệ.')
  const { rows: [team] } = await db.query('SELECT id,name FROM entrants WHERE id=$1 AND room_id=' + live, [req.params.id])
  if (!team) reject(404, 'Không tìm thấy người tham gia.')
  const { rows } = await db.query(`SELECT s.id,${submissionStatus} AS status,accepted_at AS "acceptedAt",
    ${variantProgress} AS progress,
    jsonb_array_length(s.suite)::int AS cases,
    (SELECT count(*)::int FROM awards a JOIN tasks t ON t.id=a.task_id
      WHERE t.submission_id=s.id AND a.revoked_at IS NULL) AS "newPoints",
    count(*) OVER()::int AS total FROM submissions s WHERE entrant_id=$1 AND mode='SCORE'
    ORDER BY accepted_at DESC, id LIMIT 20 OFFSET $2`, [team.id, (page - 1) * 20])
  res.json({ team, page, total: rows[0]?.total ?? 0, submissions: rows.map(({ total: _, ...row }) => row) })
})
host.post('/api/host/teams/:id/recovery', async (req, res) => {
  if (!uuid.test(req.params.id)) reject(404, 'Không tìm thấy người tham gia.')
  const ticket = secret()
  const details = await tx(async client => {
    const { rows: [entrant] } = await client.query(`UPDATE entrants e
      SET recovery_hash=$1,recovery_expires_at=clock_timestamp()+interval '10 minutes'
      FROM rooms r WHERE e.id=$2 AND e.room_id=r.id AND r.id=${live}
      AND r.opened_at>now()-interval '8 hours'
      RETURNING e.room_id,e.recovery_expires_at`, [sha(ticket), req.params.id])
    if (!entrant) reject(404, 'Không tìm thấy phiên còn hiệu lực.')
    await audit(client, entrant.room_id, 'RECOVERY_ISSUED', { entrantId: req.params.id })
    return { expiresAt: entrant.recovery_expires_at, url: publicOrigin + '/#resume=' + ticket }
  })
  res.status(201).json(details)
})
host.get('/api/host/submission/:id', async (req, res) => {
  if (!uuid.test(req.params.id)) reject(404, 'Không tìm thấy lượt nộp.')
  const { rows: [submission] } = await db.query(`SELECT s.id,suite,${submissionStatus} AS status,
    original,accepted_at AS "acceptedAt",${variantProgress} AS progress,
    (SELECT jsonb_agg(jsonb_build_object('variant',variant,'status',status,'attempt',attempt,'evidence',evidence)
      ORDER BY id) FROM tasks WHERE submission_id=s.id AND variant<>'') AS variants,
    (SELECT coalesce(jsonb_agg(to_jsonb(recent) ORDER BY recent."startedAt" DESC,recent."taskId" DESC,
      recent.fence DESC),'[]'::jsonb) FROM (
      SELECT t.id AS "taskId",t.variant,a.fence,a.started_at AS "startedAt",a.finished_at AS "finishedAt",
        a.evidence->>'outcome' AS outcome,a.evidence->'durationMs' AS "durationMs",a.evidence->'expired' AS expired
      FROM tasks t JOIN attempts a ON a.task_id=t.id WHERE t.submission_id=s.id
      ORDER BY a.started_at DESC,t.id DESC,a.fence DESC LIMIT 12
    ) recent) AS attempts
    FROM submissions s WHERE id=$1 AND room_id=${live}`, [req.params.id])
  if (!submission) reject(404, 'Không tìm thấy lượt nộp.')
  res.json(submission)
})
host.post('/api/host/open', async (req, res) => {
  const title = label(req.body?.title, 80)
  const id = randomUUID()
  await tx(async client => {
    await client.query("INSERT INTO rooms(id,title,pack_hash,state) VALUES($1,$2,$3,'OPEN')", [id, title, pack.id])
    await audit(client, id, 'OPENED', { packHash: pack.id })
  })
  res.status(201).json({ id })
})
host.post('/api/host/reset', async (req, res) => {
  const id = req.body?.roomId
  if (typeof id !== 'string' || !uuid.test(id)) reject(422, 'Phiên cần dọn không hợp lệ.')
  await tx(async client => {
    const { rows: [room] } = await client.query('SELECT id,state FROM rooms WHERE id=' + latest + ' FOR UPDATE')
    if (!room || room.id !== id || room.state === 'ARCHIVED') reject(409, 'Phiên đã thay đổi. Tải lại trước khi dọn.')
    await client.query("UPDATE rooms SET state='ARCHIVED',revision=revision+1 WHERE id=$1", [id])
    await audit(client, id, 'ARCHIVED', { previousState: room.state })
  })
  res.json({ state: 'WAITING' })
})
host.post('/api/host/:action', async (req, res) => {
  const action = req.params.action
  const data = req.body ?? {}
  const updated = await tx(async client => {
    const { rows: [room] } = await client.query('SELECT * FROM rooms WHERE id=' + live + ' FOR UPDATE')
    if (!room) reject(409, 'Chưa có phòng.')
    if (room.state === 'FINALIZED') reject(409, 'Phòng đã chốt.')
    if (action === 'pause' || action === 'resume' || action === 'close') {
      const transitions: Record<string, [string[], string]> = {
        pause: [['OPEN'], 'PAUSED'], resume: [['PAUSED'], 'OPEN'], close: [['OPEN','PAUSED'], 'CLOSED']
      }
      const [from, to] = transitions[action]
      if (!from.includes(room.state)) reject(409, 'Trạng thái phòng không phù hợp.')
      await client.query('UPDATE rooms SET state=$2,revision=revision+1 WHERE id=$1', [room.id, to])
    } else if (action === 'retry') {
      if (!/^[1-9]\d{0,15}$/.test(data.taskId)) reject(422, 'Lượt kiểm tra không hợp lệ.')
      const reason = label(data.reason, 180)
      const { rows: [task] } = await client.query(`UPDATE tasks t SET status='QUEUED',attempt=0,ready_at=clock_timestamp()
        FROM submissions s WHERE t.id=$1 AND s.id=t.submission_id AND s.room_id=$2 AND t.status='INCONCLUSIVE'
        RETURNING t.submission_id`, [data.taskId, room.id])
      if (!task) reject(409, 'Lượt này không cần chấm lại.')
      await client.query("UPDATE submissions SET status='EVALUATING' WHERE id=$1", [task.submission_id])
      await audit(client, room.id, 'RETRY', { taskId: data.taskId, reason })
      return { action }
    } else if (action === 'exclude') {
      const reason = label(data.reason, 180)
      if (room.state !== 'CLOSED' || !Object.hasOwn(pack.variants, data.variant)) reject(409, 'Đóng phòng và chọn mutant hợp lệ trước.')
      const { rowCount } = await client.query('INSERT INTO exclusions VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [room.id, data.variant, reason])
      if (!rowCount) reject(409, 'Mutant đã được loại.')
      await client.query('UPDATE awards SET revoked_at=clock_timestamp() WHERE room_id=$1 AND variant=$2 AND revoked_at IS NULL', [room.id, data.variant])
      const { rows } = await client.query(`UPDATE tasks t SET status='EXCLUDED',lease_until=NULL FROM submissions s
        WHERE s.room_id=$1 AND s.id=t.submission_id AND t.variant=$2 RETURNING t.submission_id`, [room.id, data.variant])
      for (const row of rows) await refreshSubmission(client, row.submission_id)
      await revise(client, room.id)
      await audit(client, room.id, 'EXCLUDE', { variant: data.variant, reason })
      return { action }
    } else if (action === 'finalize') {
      if (room.state !== 'CLOSED') reject(409, 'Đóng nhận bài trước khi chốt.')
      const { rows: [row] } = await client.query(`SELECT count(*)::int AS remaining FROM tasks t JOIN submissions s ON s.id=t.submission_id
        WHERE s.room_id=$1 AND (t.status IN ('QUEUED','LEASED') OR (t.status='INCONCLUSIVE' AND s.mode='SCORE'))`, [room.id])
      if (row.remaining) reject(409, 'Còn ' + row.remaining + ' lượt chạy cần xử lý.')
      await client.query("UPDATE rooms SET state='FINALIZED',revision=revision+1 WHERE id=$1", [room.id])
      await audit(client, room.id, 'FINALIZED')
      const report = await reportFor(client, room.id)
      await client.query('UPDATE rooms SET final_report=$2 WHERE id=$1', [room.id, report])
      return { action }
    } else reject(404, 'Thao tác không tồn tại.')
    await audit(client, room.id, action.toUpperCase())
    return { action }
  })
  res.json(updated)
})

async function reportFor(client: any, id: string) {
  const { rows: [room] } = await client.query('SELECT id,title,pack_hash,state,revision,opened_at FROM rooms WHERE id=$1', [id])
  const { rows: results } = await client.query(`SELECT e.name,a.variant,t.evidence FROM awards a
    JOIN entrants e ON e.id=a.entrant_id JOIN tasks t ON t.id=a.task_id
    WHERE a.room_id=$1 AND a.revoked_at IS NULL ORDER BY e.name,a.variant`, [id])
  const { rows: totals } = await client.query(`SELECT e.name,count(a.variant)::int AS points
    FROM entrants e LEFT JOIN awards a ON a.entrant_id=e.id AND a.revoked_at IS NULL
    WHERE e.room_id=$1 GROUP BY e.id ORDER BY points DESC,e.name`, [id])
  const { rows: events } = await client.query('SELECT action,details,created_at FROM audit WHERE room_id=$1 ORDER BY id', [id])
  const { rows: outcomes } = await client.query(`SELECT t.status,count(*)::int AS count FROM tasks t
    JOIN submissions s ON s.id=t.submission_id WHERE s.room_id=$1 AND s.mode='SCORE' GROUP BY t.status ORDER BY t.status`, [id])
  const { rows: attempts } = await client.query(`SELECT t.submission_id,t.variant,a.fence,
    a.evidence - 'results' AS evidence FROM attempts a JOIN tasks t ON t.id=a.task_id
    JOIN submissions s ON s.id=t.submission_id WHERE s.room_id=$1 AND s.mode='SCORE'
    AND (a.evidence->>'outcome' IN ('TIMEOUT','INFRA_FAILURE','SUT_RUNTIME_ERROR') OR a.evidence IS NULL)
    ORDER BY t.id,a.fence`, [id])
  const report = { room, totals, results, outcomes, events, attempts }
  return { ...report, sha256: sha(canonical(report)) }
}
host.get('/api/host/report', async (_req, res) => {
  const { rows: [room] } = await db.query('SELECT id,final_report FROM rooms WHERE id=' + live)
  if (!room) reject(404, 'Chưa có phòng.')
  res.attachment('t10-room-report.json').json(room.final_report ?? await tx(client => reportFor(client, room.id)))
})
host.get('/api/host/archives/:id/report', async (req, res) => {
  if (!uuid.test(req.params.id)) reject(404, 'Không tìm thấy phiên đã lưu.')
  const { rows: [room] } = await db.query("SELECT id,final_report FROM rooms WHERE id=$1 AND state='ARCHIVED'", [req.params.id])
  if (!room) reject(404, 'Không tìm thấy phiên đã lưu.')
  res.attachment('t10-archived-room-report.json').json(room.final_report ?? await tx(client => reportFor(client, room.id)))
})
catchErrors(host)

const { rows: [active] } = await db.query("SELECT pack_hash FROM rooms WHERE state IN ('OPEN','PAUSED','CLOSED')")
if (active && active.pack_hash !== pack.id) throw new Error('Active room references a different private pack')
publicApp.listen(8787, '0.0.0.0', () => console.log('Participant ready', pack.id))
host.listen(8788, '0.0.0.0', () => console.log('Host ready'))
