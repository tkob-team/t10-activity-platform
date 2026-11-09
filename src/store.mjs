import {DatabaseSync} from 'node:sqlite'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {dirname} from 'node:path'
import {mkdirSync} from 'node:fs'

export const digest = value => createHash('sha256').update(value).digest('hex')
const randomKey = () => randomBytes(32).toString('base64url')
const now = () => Date.now()
export class HttpError extends Error {
  constructor(status,message) { super(message); this.status = status }
}
const reject = (status,message) => { throw new HttpError(status,message) }

export function openStore(filename,{currentPack,legacyPack,getPack}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename),{recursive:true,mode:0o700})
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
  db.exec(
    'CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,label TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN (\'SETUP\',\'OPEN\',\'CLOSED\')),created INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS entrants(id TEXT PRIMARY KEY,room TEXT NOT NULL REFERENCES rooms(id),name TEXT NOT NULL,normalized TEXT NOT NULL,kind TEXT NOT NULL,assigned TEXT NOT NULL,recovery TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(room,normalized));' +
    'CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,entrant TEXT NOT NULL REFERENCES entrants(id),expires INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,entrant TEXT NOT NULL REFERENCES entrants(id),room TEXT NOT NULL REFERENCES rooms(id),problem TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,suite TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(entrant,key));' +
    'CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(entrant) WHERE state IN (\'QUEUED\',\'RUNNING\');' +
    'CREATE INDEX IF NOT EXISTS job_queue ON jobs(state,created);' +
    'CREATE TABLE IF NOT EXISTS points(entrant TEXT NOT NULL REFERENCES entrants(id),problem TEXT NOT NULL,mutant TEXT NOT NULL,job TEXT NOT NULL REFERENCES jobs(id),PRIMARY KEY(entrant,mutant));'
  )
  const q = sql => db.prepare(sql)
  for (const [table,columns] of [
    ['rooms',[['pack','TEXT']]],
    ['jobs',[['pack','TEXT'],['mode',"TEXT NOT NULL DEFAULT 'SCORE'"],['audit','TEXT']]]
  ]) {
    const present=new Set(q('PRAGMA table_info('+table+')').all().map(row=>row.name))
    for (const [key,type] of columns) if (!present.has(key)) db.exec('ALTER TABLE '+table+' ADD COLUMN '+key+' '+type)
  }
  if (q('SELECT 1 FROM rooms WHERE pack IS NULL LIMIT 1').get() ||
      q('SELECT 1 FROM jobs WHERE pack IS NULL LIMIT 1').get()) {
    if (!legacyPack) {
      db.close()
      throw new Error('An existing room needs its original pack.json. Restore it or use a separate ACTIVITY_DB.')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      q('UPDATE rooms SET pack=? WHERE pack IS NULL').run(legacyPack.id)
      q('UPDATE jobs SET pack=? WHERE pack IS NULL').run(legacyPack.id)
      db.exec('COMMIT')
    } catch(error) {db.exec('ROLLBACK');db.close();throw error}
  }
  const tx = callback => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = callback(); db.exec('COMMIT'); return result } catch(error) { db.exec('ROLLBACK'); throw error }
  }
  function room() {
    return q('SELECT id,label,state,created,pack FROM rooms ORDER BY rowid DESC LIMIT 1').get()
  }
  function createRoom(label) {
    return tx(() => {
      if (room()?.state !== 'CLOSED' && room()) reject(409,'Cần đóng phòng hiện tại trước.')
      if (pendingCount()) reject(409,'Đợi hàng đợi hoàn tất trước khi tạo phòng.')
      q('INSERT INTO rooms (id,label,state,created,pack) VALUES (?,?,?,?,?)').run(randomUUID(),label,'SETUP',now(),currentPack.id)
      return room()
    })
  }
  if (!room()) createRoom('Seminar T10')
  const initial=room()
  if (legacyPack && initial.pack===legacyPack.id && initial.state!=='CLOSED' &&
      !q('SELECT 1 FROM entrants WHERE room=? LIMIT 1').get(initial.id)) {
    q('UPDATE rooms SET pack=? WHERE id=?').run(currentPack.id,initial.id)
  }
  try {getPack(room().pack)} catch(error) {db.close();throw error}
  q("UPDATE jobs SET state='QUEUED',updated=? WHERE state='RUNNING'").run(now())
  function changeRoom(state) {
    const current = room()
    if ((state==='OPEN' && current.state!=='SETUP') || (state==='CLOSED' && current.state==='CLOSED')) {
      reject(409,'Trạng thái phòng không cho phép thao tác này.')
    }
    q('UPDATE rooms SET state=? WHERE id=?').run(state,current.id)
    return room()
  }
  function issue(id) {
    const token = randomKey()
    q('DELETE FROM sessions WHERE entrant=? OR expires<=?').run(id,now())
    q('INSERT INTO sessions VALUES (?,?,?)').run(digest(token),id,now()+8*60*60*1000)
    return token
  }
  function join(kind,name,limit) {
    return tx(() => {
      const current = room()
      if (current.state !== 'OPEN') reject(409,'Phòng chưa mở nhận người chơi.')
      if (q('SELECT count(*) AS n FROM entrants WHERE room=?').get(current.id).n >= limit) reject(429,'Phòng đã đạt giới hạn người chơi.')
      const normalized = name.normalize('NFKC').toLocaleLowerCase('vi')
      if (q('SELECT 1 FROM entrants WHERE room=? AND normalized=?').get(current.id,normalized)) reject(409,'Tên đã được dùng trong phòng.')
      const counts = new Map(q('SELECT assigned,count(*) AS n FROM entrants WHERE room=? GROUP BY assigned').all(current.id).map(r=>[r.assigned,r.n]))
      const assigned = Object.values(getPack(current.pack).rounds).sort((a,b)=>(counts.get(a.id)||0)-(counts.get(b.id)||0))[0].id
      const id=randomUUID()
      q('INSERT INTO entrants VALUES (?,?,?,?,?,?,?,?)').run(id,current.id,name,normalized,kind,assigned,digest(randomKey()),now())
      return {entrant:{id,name,kind,assigned,room:current.id},token:issue(id)}
    })
  }
  function authenticate(token) {
    if (typeof token!=='string' || !/^[\w-]{43}$/.test(token)) return undefined
    return q('SELECT e.id,e.name,e.kind,e.assigned,e.room FROM sessions s JOIN entrants e ON e.id=s.entrant WHERE s.hash=? AND s.expires>?').get(digest(token),now())
  }
  function recover(key) {
    return tx(() => {
      const row = q('SELECT id,name,kind,assigned,room FROM entrants WHERE room=? AND recovery=?').get(room().id,digest(key))
      if (!row) reject(401,'Mã khôi phục không hợp lệ cho phòng hiện tại.')
      return {entrant:row,token:issue(row.id)}
    })
  }
  function logout(token) {
    if (typeof token==='string' && /^[\w-]{43}$/.test(token)) q('DELETE FROM sessions WHERE hash=?').run(digest(token))
  }
  function pendingCount() {
    return q("SELECT count(*) AS n FROM jobs WHERE state IN ('QUEUED','RUNNING')").get().n
  }
  function submit(entrant,problem,key,suite,limit,mode,pack) {
    const raw = JSON.stringify(suite)
    const fingerprint=digest(JSON.stringify({problem,mode,pack,suite}))
    return tx(() => {
      const prior = q('SELECT id,state,fingerprint FROM jobs WHERE entrant=? AND key=?').get(entrant.id,key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) reject(409,'Khóa lượt nộp đã dùng cho nội dung khác.')
        return {id:prior.id,state:prior.state,reused:true}
      }
      const current = room()
      if (current.state!=='OPEN' || current.id!==entrant.room || current.pack!==pack) reject(409,'Phòng đã đóng nhận bài.')
      if (q("SELECT 1 FROM jobs WHERE entrant=? AND state IN ('QUEUED','RUNNING')").get(entrant.id)) reject(409,'Bạn đã có một bài đang chờ hoặc đang chấm.')
      const cap=mode==='PREVIEW'?24:48
      if (q('SELECT count(*) AS n FROM jobs WHERE entrant=? AND mode=?').get(entrant.id,mode).n>=cap) {
        reject(429,mode==='PREVIEW'?'Bạn đã dùng hết lượt chạy thử.':'Bạn đã dùng hết lượt nộp trong phòng.')
      }
      if (pendingCount() >= limit) reject(429,'Hàng đợi đang đầy. Thử lại sau.')
      const id = randomUUID()
      q('INSERT INTO jobs (id,entrant,room,problem,key,fingerprint,suite,state,created,updated,pack,mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,entrant.id,entrant.room,problem,key,fingerprint,raw,'QUEUED',now(),now(),pack,mode)
      return {id,state:'QUEUED',reused:false}
    })
  }
  function claim() {
    return tx(() => {
      const job = q("SELECT id,entrant,problem,suite,pack,mode FROM jobs WHERE state='QUEUED' ORDER BY created,rowid LIMIT 1").get()
      if (job) q("UPDATE jobs SET state='RUNNING',updated=? WHERE id=?").run(now(),job.id)
      return job
    })
  }
  function finish(id,result) {
    return tx(() => {
      const job = q("SELECT entrant,problem,pack,mode FROM jobs WHERE id=? AND state='RUNNING'").get(id)
      if (!job) return
      let newPoints = 0
      if (result.status==='GRADED') for (const row of result.variants) {
        if (row.status==='KILLED') newPoints += q('INSERT OR IGNORE INTO points VALUES (?,?,?,?)').run(job.entrant,job.problem,row.id,id).changes
      }
      const counts = {}
      for (const variant of result.variants || []) counts[variant.status] = (counts[variant.status]||0)+1
      const threshold=getPack(job.pack).rounds[job.problem].minScore
      const score=q('SELECT count(*) AS n FROM points WHERE entrant=? AND problem=?').get(job.entrant,job.problem).n
      const summary={status:result.status,original:result.original,counts,newPoints,score,threshold,
        passed:score>=threshold,alreadyCredited:result.alreadyCredited??0}
      q('UPDATE jobs SET state=?,result=?,audit=?,updated=? WHERE id=?')
        .run('DONE',JSON.stringify(summary),JSON.stringify(result.variants??[]),now(),id)
    })
  }
  function jobView(row) {
    if (!row) return row
    const {suite,...rest}=row
    return {...rest,result:row.result?JSON.parse(row.result):null,...(suite?{snapshot:JSON.parse(suite)}:{})}
  }
  function job(entrant,id) {
    return jobView(q('SELECT id,problem,mode,state,result,suite,created,updated FROM jobs WHERE id=? AND entrant=?').get(id,entrant.id))
  }
  const summaryColumns="id,problem,mode,state,json_remove(result,'$.original.results') AS result,created,updated"
  function recent(entrant) {
    return q('SELECT '+summaryColumns+' FROM jobs WHERE entrant=? ORDER BY rowid DESC LIMIT 16').all(entrant.id).map(jobView)
  }
  function latestScores(entrant) {
    return q('SELECT '+summaryColumns+" FROM jobs WHERE rowid IN (SELECT max(rowid) FROM jobs WHERE entrant=? AND mode='SCORE' AND state='DONE' GROUP BY problem)")
      .all(entrant.id).map(jobView)
  }
  function credited(entrant,problem) {
    return q('SELECT mutant FROM points WHERE entrant=? AND problem=?').all(entrant,problem).map(row=>row.mutant)
  }
  function leaderboard() {
    const rounds=Object.values(getPack(room().pack).rounds)
    const entries = q('SELECT id,name,kind FROM entrants WHERE room=? ORDER BY created,rowid').all(room().id)
    const points = q('SELECT p.entrant,p.problem,count(*) AS n FROM points p JOIN entrants e ON e.id=p.entrant WHERE e.room=? GROUP BY p.entrant,p.problem').all(room().id)
    const rows = entries.map(({id,name,kind})=>{
      const byProblem = Object.fromEntries(rounds.map(p=>[p.id,0]))
      for (const point of points) if (point.entrant===id) byProblem[point.problem] = point.n
      const passedByProblem=Object.fromEntries(rounds.map(round=>[round.id,byProblem[round.id]>=round.minScore]))
      return {id,name,kind,byProblem,passedByProblem,score:Object.values(byProblem).reduce((a,b)=>a+b,0)}
    }).sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name,'vi'))
    let rank = 0
    return rows.map((row,i)=>{
      if (!i || rows[i-1].score!==row.score) rank=i+1
      return {...row,rank}
    })
  }
  function stats() {
    const current = room()
    const pack=getPack(current.pack)
    const jobs = q('SELECT state,count(*) AS count FROM jobs WHERE room=? GROUP BY state').all(current.id)
    const failures=q("SELECT j.problem,j.mode,e.name,CASE WHEN j.mode='PREVIEW' THEN json_extract(j.result,'$.original.status') ELSE json_extract(j.result,'$.status') END AS status FROM jobs j JOIN entrants e ON e.id=j.entrant WHERE j.room=? AND (json_extract(j.result,'$.status') IN ('RUN_ERROR','SYSTEM_ERROR','TIMEOUT') OR json_extract(j.result,'$.original.status') IN ('RUN_ERROR','TIMEOUT')) ORDER BY j.updated DESC LIMIT 8").all(current.id)
    return {room:current,entrants:q('SELECT count(*) AS n FROM entrants WHERE room=?').get(current.id).n,
      packVersion:pack.version,rounds:Object.values(pack.rounds).map(round=>({
        title:round.title,minScore:round.minScore,total:round.mutants.length
      })),failures,jobs:Object.fromEntries(jobs.map(x=>[x.state,x.count])),pending:pendingCount()}
  }
  function exportResults() {
    const current = room()
    return {...stats(),leaderboard:leaderboard(),
      results:q('SELECT id,entrant,problem,mode,pack,state,result,suite,audit,created,updated FROM jobs WHERE room=? ORDER BY rowid')
        .all(current.id).map(row=>({...jobView(row),audit:row.audit?JSON.parse(row.audit):null}))}
  }
  return {room,createRoom,changeRoom,join,authenticate,recover,logout,submit,claim,finish,job,recent,latestScores,credited,leaderboard,stats,exportResults,close:()=>db.close()}
}
