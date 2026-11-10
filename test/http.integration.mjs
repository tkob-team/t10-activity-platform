import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { controls, scoringSuites } from './controls.mjs'

const publicUrl = process.env.LAB_TEST_PUBLIC || 'http://127.0.0.1:19787'
const hostUrl = process.env.LAB_TEST_HOST || 'http://127.0.0.1:19788'
const project = process.env.LAB_TEST_PROJECT || 't10-lab-check'
const cases = scoringSuites.at(-1)
const authPoints = Object.keys(controls).filter(id=>id.startsWith('auth-')).length
const poolSize = Object.keys(controls).length
const empty = "test('Account profile', async () => { const account = await sut.profile('alice'); expect(account.status).toBe(200); })"
const waiting = new Set(['QUEUED','VERIFYING_ORIGINAL','EVALUATING'])
const note = (step, details) => console.log(JSON.stringify({ step, ...details }))

function compose(...args) {
  const outcome = spawnSync('docker', ['compose','-p',project,...args], { encoding:'utf8', timeout:30000 })
  assert.equal(outcome.status, 0, outcome.stderr || outcome.error?.message)
}
async function call(path, { base = publicUrl, headers = {}, body, status = 200 } = {}) {
  const response = await fetch(base + path, {
    headers: { ...(body ? {'content-type':'application/json'} : {}), ...headers },
    ...(body ? { method:'POST', body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(10000)
  })
  const result = await response.json()
  assert.equal(response.status, status, path + ' ' + JSON.stringify(result))
  return { result, cookie:response.headers.get('set-cookie')?.split(';')[0] }
}
const host = (path, body, status) => call('/api/host' + path, { base:hostUrl, body, status })
async function join(name) {
  const { result, cookie } = await call('/api/join',{ body:{name},status:201 })
  return { ...result, cookie }
}
async function getJob(team, id, status = 200) {
  return (await call('/api/submissions/' + id, { headers:{cookie:team.cookie},status })).result
}
async function receipt(team, packHash, code, { mode = 'SCORE', key = randomUUID(), status = 202, builder = [] } = {}) {
  return (await call('/api/submissions',{
    headers:{ cookie:team.cookie, 'idempotency-key':key },
    body:{ packHash, code, builder, mode }, status
  })).result
}
async function until(check, match, timeout = 180000) {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    const result = await check()
    if (match(result)) return result
    await delay(180)
  }
  assert.fail('Timed out waiting for expected status')
}
async function terminal(team, id) {
  return until(() => getJob(team,id), job => !waiting.has(job.status))
}

await host('')
await call('/api/host',{ base:hostUrl,headers:{origin:'https://example.test'},status:403 })
await call('/api/host/open',{ base:hostUrl,headers:{'sec-fetch-site':'cross-site'},body:{title:'Cross-site'},status:403 })
await call('/api/activity',{ status:401 })
await call('/api/host',{ status:401 })
for (const path of ['/', '/projector', '/styles.css', '/app.js', '/builder.js', '/ranking.js','/editor.js','/results.js']) {
  assert.equal((await fetch(publicUrl + path)).status, 200, path)
}
const page = await fetch(publicUrl + '/')
const html = await page.text()
const nonce = /name="editor-style-nonce" content="([^"]+)"/.exec(html)?.[1]
assert.ok(nonce && page.headers.get('content-security-policy').includes("'nonce-"+nonce+"'"))
assert.ok(!html.includes('Chạy kiểm tra trên bản gốc') && !html.includes('Mã khôi phục phiên') && !html.includes('Mã phòng'))
assert.equal((await fetch(hostUrl + '/admin.js')).status, 200)
assert.equal((await fetch(publicUrl + '/admin.js')).status, 404)
await host('/open',{ title:'Automated qualification' },201)
let sample = await join('Test 01')
const { result: pack } = await call('/api/activity',{ headers:{cookie:sample.cookie} })
assert.deepEqual(pack.features.map(({id})=>id),['orders','coupons','auth'])
assert.ok(!JSON.stringify(pack).includes('coupons-120'))
assert.ok(!Object.hasOwn(sample,'recovery'))
const ticket = async () => new URL((await host('/teams/'+sample.id+'/recovery',{},201)).result.url).hash.split('=')[1]
const staleTicket = await ticket()
const activeTicket = await ticket()
await call('/api/recover',{body:{recovery:staleTicket},status:403})
const recovered = await call('/api/recover',{body:{recovery:activeTicket}})
await call('/api/recover',{body:{recovery:activeTicket},status:403})
assert.equal(recovered.result.id,sample.id)
assert.ok(!Object.hasOwn(recovered.result,'recovery'))
await call('/api/session',{headers:{cookie:sample.cookie},status:401})
sample = { ...recovered.result,cookie:recovered.cookie }

const builder = [{ name:'Đọc tài khoản', scenario:'standard', steps:[
  { kind:'call',as:'account',op:'profile',args:['alice'] },
  { kind:'assert',actual:'account.status',matcher:'toBe',expected:200 }
]}]
await receipt(sample,pack.packHash,'',{mode:'PREVIEW',builder,status:422})
await receipt(sample,pack.packHash,empty,{builder,status:422})
const built = await terminal(sample,(await receipt(sample,pack.packHash,'',{builder})).id)
assert.equal(built.status,'GRADED')
assert.equal(built.original.outcome,'ALL_PASS')
assert.equal(built.newPoints,0)
const invalid = await terminal(sample,(await receipt(sample,pack.packHash,empty.replace('toBe(200)','toBe(201)'))).id)
assert.equal(invalid.status,'ORIGINAL_FAILED')
assert.equal(invalid.progress.total,0)
await receipt(sample,pack.packHash,"test('unsafe',()=>{process.exit()})",{ status:422 })
const overview = (await host('')).result
assert.deepEqual(overview.teams.map(({name,points,submissions})=>[name,points,submissions]),[['Test 01',0,2]])
const teamView = (await host('/teams/'+sample.id)).result
assert.equal(teamView.total,2)
assert.equal(teamView.submissions[0].id,invalid.id)
const hostJob = (await host('/submission/'+invalid.id)).result
assert.equal(hostJob.original.results[0].steps[1].actual,'200')
assert.equal(hostJob.original.results[0].steps[1].expected,'201')
assert.equal(hostJob.suite.length,1)
assert.equal(hostJob.attempts.length,1)
assert.equal(hostJob.attempts[0].variant,'')
assert.equal(hostJob.attempts[0].outcome,'ASSERTION_MISMATCH')
note('Host roster and submission details, one-time recovery, single-mode submission and original rejection', { passed:true })

compose('pause','executor')
let interrupted
try {
  interrupted = await receipt(sample,pack.packHash,cases)
  await until(() => getJob(sample,interrupted.id), job => job.status === 'VERIFYING_ORIGINAL',5000)
  const grading = (await host('/submission/'+interrupted.id)).result
  assert.equal(grading.status,'VERIFYING_ORIGINAL')
  assert.equal(grading.attempts[0].finishedAt,null)
  assert.equal((await host('/teams/'+sample.id)).result.submissions[0].status,'VERIFYING_ORIGINAL')
  compose('kill','-s','SIGKILL','scheduler')
} finally {
  compose('unpause','executor')
  compose('start','scheduler')
}
const recoveredJob = await terminal(sample,interrupted.id)
assert.equal(recoveredJob.status,'GRADED')
assert.equal(recoveredJob.newPoints,authPoints)
const gradedView = (await host('/submission/'+interrupted.id)).result
assert.deepEqual(gradedView.progress,recoveredJob.progress)
assert.equal(gradedView.attempts.length,12)
assert.ok(gradedView.attempts.every(attempt=>attempt.finishedAt))
assert.deepEqual((await call('/api/score',{headers:{cookie:sample.cookie}})).result,{points:authPoints,maxPoints:poolSize})
note('Scheduler killed during an active lease', { submissionId:interrupted.id, recovered:recoveredJob.status, points:recoveredJob.newPoints })

const fault = spawn('docker', ['compose','-p',project,'exec','-T','executor','node','-e',`
  const fs = require('node:fs');
  const timer = setInterval(() => {
    for (const pid of fs.readdirSync('/proc').filter(name=>/^\\d+$/.test(name))) {
      try {
        const args = fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean);
        if (args.at(-1) === '/lab/src/worker.ts') {
          process.kill(Number(pid),'SIGKILL');
          clearInterval(timer);
          process.exit(0);
        }
      } catch {}
    }
  }, 10);
  console.log('watching');
  setTimeout(()=>process.exit(1),8000).unref();
`], { stdio:['ignore','pipe','inherit'] })
const faultExit = new Promise(resolve => fault.once('exit', resolve))
await new Promise((resolve,reject) => {
  const timer = setTimeout(() => reject(new Error('Fault probe did not start')),5000)
  fault.stdout.once('data', () => { clearTimeout(timer); resolve() })
  fault.once('error', reject)
})
const faultJob = await receipt(sample,pack.packHash,cases)
assert.equal(await faultExit,0)
const afterCrash = await terminal(sample,faultJob.id)
assert.equal(afterCrash.status,'GRADED')
assert.equal(afterCrash.original.outcome,'ALL_PASS')
assert.equal(afterCrash.newPoints,0)
note('Executor child killed with SIGKILL and retried', { submissionId:faultJob.id, points:afterCrash.newPoints })

const teams = [sample,...await Promise.all([2,3,4,5,6].map(i=>join('Test 0'+i)))]
const other = teams[1]
await getJob(other,interrupted.id,404)
const key = randomUUID()
const first = await receipt(sample,pack.packHash,cases,{ key })
const replay = await receipt(sample,pack.packHash,cases,{ key })
assert.equal(first.id,replay.id)
await receipt(sample,pack.packHash,empty,{ key,status:409 })
assert.equal((await terminal(sample,first.id)).newPoints,0)

const elapsed = []
for (let round=0; round<3; round++) {
  const batch = await Promise.all(teams.map(async (team,index)=>{
    const start = performance.now()
    const code = index === 0 ? cases : (round === 0 && index === 1 ? cases : empty)
    const { id } = await receipt(team,pack.packHash,code)
    const job = await terminal(team,id)
    assert.equal(job.status,'GRADED')
    assert.equal(job.progress.inconclusive,0)
    assert.equal(job.newPoints,round === 0 && index === 1 ? authPoints : 0)
    return Math.round(performance.now()-start)
  }))
  elapsed.push(...batch)
  note('Concurrent scoring batch', { round:round+1, teams:6, durationMs:batch })
}
elapsed.sort((a,b)=>a-b)
note('Six-entrant latency summary', { samples:elapsed.length,p50:elapsed[Math.ceil(elapsed.length*.5)-1],p95:elapsed[Math.ceil(elapsed.length*.95)-1],max:elapsed.at(-1) })

const ranking = (await call('/api/ranking')).result
assert.deepEqual(ranking.teams.map(({rank,score})=>[rank,score]),[[1,authPoints],[1,authPoints],[3,0],[3,0],[3,0],[3,0]])
const stream = await fetch(publicUrl + '/api/ranking/events')
assert.match(stream.headers.get('content-type'),/text\/event-stream/)
const reader = stream.body.getReader()
assert.match(new TextDecoder().decode((await reader.read()).value),/event: ranking/)
await reader.cancel()

await host('/pause',{})
await receipt(sample,pack.packHash,empty,{status:409})
await host('/resume',{})
const beforeClose = await receipt(teams[2],pack.packHash,empty)
await host('/close',{})
await receipt(sample,pack.packHash,empty,{status:409})
assert.equal((await terminal(teams[2],beforeClose.id)).status,'GRADED')
await host('/exclude',{variant:'auth-47',reason:'Qualification of room-wide revocation'})
assert.deepEqual((await call('/api/score',{headers:{cookie:sample.cookie}})).result,{points:authPoints-1,maxPoints:poolSize-1})
await host('/finalize',{})
const report = (await host('/report')).result
assert.equal(report.room.state,'FINALIZED')
assert.equal(report.totals[0].points,authPoints-1)
assert.equal(report.totals[1].points,authPoints-1)
assert.ok(report.events.some(event=>event.action==='EXCLUDE'))
assert.ok(report.attempts.some(attempt=>attempt.submission_id===interrupted.id && attempt.evidence?.expired))
assert.ok(report.attempts.some(attempt=>attempt.submission_id===faultJob.id && attempt.evidence?.signal==='SIGKILL'))
note('Close, drain, ranking tie, SSE and finalize', { report:report.sha256,room:report.room.id,points:report.totals.map(team=>team.points) })

await host('/open',{title:'Full-pool load qualification'},201)
const fresh = await Promise.all(Array.from({length:6},(_,i)=>join('Full pool '+(i+1))))
const heavy = Array.from({length:12},(_,i)=>"test('Profile case "+i+"',async()=>{ await sut.setClock(1); const first=await sut.profile('alice'); expect(first.status).toBe(200); expect(first.body.name).toBe('alice'); const second=await sut.profile('bob'); expect(second.status).toBe(200); expect(second.body.name).toBe('bob'); })").join('\n')
const fullPoolMs = await Promise.all(fresh.map(async team=>{
  const start = performance.now()
  const job = await terminal(team,(await receipt(team,pack.packHash,heavy)).id)
  assert.equal(job.status,'GRADED')
  assert.equal(job.progress.total,poolSize)
  assert.equal(job.progress.inconclusive,0)
  assert.equal(job.newPoints,0)
  return Math.round(performance.now()-start)
}))
note('Six fresh entrants, full pool, 12 cases and 84 steps per suite', { poolSize,durationMs:fullPoolMs,max:Math.max(...fullPoolMs) })
await host('/close',{})
await host('/finalize',{})
const fullReport = (await host('/report')).result
note('Full-pool report', { room:fullReport.room.id, report:fullReport.sha256 })

await host('/reset',{roomId:fullReport.room.id})
assert.deepEqual((await host('/archives/'+fullReport.room.id+'/report')).result,fullReport)
assert.equal((await host('')).result.state,'WAITING')
assert.deepEqual((await call('/api/ranking')).result,{state:'WAITING',teams:[]})
await call('/api/join',{body:{name:'Room reset'},status:409})

const previous = (await host('/open',{title:'Archive during grading'},201)).result.id
const oldTeam = await join('Room reset')
let pending
compose('pause','executor')
try {
  pending = await receipt(oldTeam,pack.packHash,cases)
  await until(()=>getJob(oldTeam,pending.id),job=>job.status==='VERIFYING_ORIGINAL',5000)
  await host('/reset',{roomId:previous})
} finally {
  compose('unpause','executor')
}
await call('/api/session',{headers:{cookie:oldTeam.cookie},status:401})
await getJob(oldTeam,pending.id,401)
const replacement = (await host('/open',{title:'Replacement room'},201)).result.id
await host('/reset',{roomId:previous},409)
const newTeam = await join(oldTeam.name)
assert.notEqual(newTeam.id,oldTeam.id)
assert.equal(newTeam.room,replacement)
assert.equal((await call('/api/ranking')).result.teams[0].score,0)
const newJob = await terminal(newTeam,(await receipt(newTeam,pack.packHash,cases)).id)
assert.equal(newJob.newPoints,authPoints)
const archive = (await host('/archives/'+previous+'/report')).result
assert.equal(archive.room.state,'ARCHIVED')
assert.deepEqual(archive.results,[])
await host('/close',{})
await host('/finalize',{})
note('Code-free join and reset during a live lease, stale reset rejection, preserved archive and fresh score', { passed:true })
