import {createServer} from 'node:http'
import {resolve} from 'node:path'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {randomBytes} from 'node:crypto'
import {openPackRegistry,roundSummary,publicProblem} from './pack.mjs'
import {prepareSuite} from './submission.mjs'
import {judge} from './judge.mjs'
import {openStore,HttpError} from './store.mjs'
import {secureEqual,securityHeaders,jsonResponse,jsonBody,originGuard,clientAddress,limiter,readName} from './http-security.mjs'

const root = fileURLToPath(new URL('../',import.meta.url))
const assets = new Map([
  ['/', ['index.html','text/html']], ['/app.js',['app.js','application/javascript']], ['/styles.css',['styles.css','text/css']],
  ...['ui.js','builder.js','drafts.js','results.js'].map(name=>['/'+name,[name,'application/javascript']])
])
const adminAssets = new Map([
  ['/', ['admin.html','text/html']], ['/admin.js',['admin.js','application/javascript']], ['/styles.css',['styles.css','text/css']]
])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const json = jsonResponse
const loopback = '127.0.0.1'
const serveAssets = files => new Map([...files].map(([url,[name,type]])=>[url,[readFileSync(resolve(root,'public',name)),type]]))
const unavailable = () => { throw new HttpError(404,'Không tìm thấy.') }

export function configFromEnv(env=process.env) {
  const production = env.NODE_ENV==='production'
  const value = (key,fallback,min,max) => {
    if (env[key] === undefined || env[key] === '') return fallback
    const number = Number(env[key])
    if (!Number.isInteger(number) || number<min || number>max) throw new Error('Invalid ' + key)
    return number
  }
  const origin = env.APP_ORIGIN || ''
  if (origin) {
    const url = new URL(origin)
    if (url.origin!==origin || !['http:','https:'].includes(url.protocol)) throw new Error('APP_ORIGIN must be an exact origin')
  }
  if (production && (!origin.startsWith('https://') || (env.ADMIN_KEY || '').length<32)) {
    throw new Error('Production requires HTTPS APP_ORIGIN and an ADMIN_KEY of at least 32 characters')
  }
  return {
    production, origin, adminKey:env.ADMIN_KEY || randomBytes(32).toString('base64url'),
    joinCode:env.JOIN_CODE || '', trustTunnel:env.TRUST_TUNNEL==='1',
    port:value('PORT',8787,0,65535), adminPort:value('ADMIN_PORT',8788,0,65535),
    maxEntrants:value('MAX_ENTRANTS',96,1,500), maxQueue:value('MAX_QUEUE',24,1,200),
    workers:value('JUDGE_WORKERS',2,1,6), timeout:value('RUN_TIMEOUT_MS',9000,1000,30000),
    packPath:resolve(env.SUT_PACK_FILE || resolve(root,'.runtime/eshop/pack-v2.json')),
    legacyPackPath:resolve(env.SUT_LEGACY_PACK_FILE || resolve(root,'.runtime/eshop/pack.json')),
    database:env.ACTIVITY_DB === ':memory:' ? ':memory:' : resolve(env.ACTIVITY_DB || resolve(root,'data/activity.sqlite'))
  }
}
function responseError(error,res) {
  const status = error instanceof HttpError ? error.status : 500
  if (status===429) res.setHeader('Retry-After','10')
  if (status===500) console.error('Internal activity error:',error.code || error.name)
  json(res,status,{error:status===500?'Máy chủ gặp lỗi.':error.message})
}
function sendAsset(res,asset,head) {
  const [data,type] = asset
  res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Content-Length':data.length})
  res.end(head?undefined:data)
}
function makeServer(handler) {
  const server = createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:10000,
    keepAliveTimeout:2500,connectionsCheckingInterval:1000},handler)
  server.maxConnections=200
  server.maxRequestsPerSocket=80
  return server
}

export async function launch(config) {
  const packs=openPackRegistry(config.packPath,config.legacyPackPath)
  const publicFiles=serveAssets(assets), privateFiles=serveAssets(adminAssets)
  let store
  const rate = limiter()
  const burst = limiter({period:1000})
  const adminRate = limiter({capacity:32})
  const running = new Set()
  let stopping = false
  const cookieName = config.production ? '__Host-t10_session' : 't10_session'
  const cookie = (res,token,maxAge=28800) => res.setHeader('Set-Cookie',
    cookieName+'='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+maxAge+(config.production?'; Secure':''))
  function cookieToken(req) {
    const source = req.headers.cookie || ''
    return source.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)
  }
  function requireEntrant(req) {
    const entrant = store.authenticate(cookieToken(req))
    if (!entrant || entrant.room!==store.room().id) throw new HttpError(401,'Vào lại phòng để tiếp tục.')
    return entrant
  }
  function pump() {
    if (stopping) return
    while (running.size<config.workers) {
      const job = store.claim()
      if (!job) break
      const task=Promise.resolve().then(()=>{
        const pack=packs.get(job.pack)
        const problem=pack.rounds[job.problem]
        return judge(pack,problem,JSON.parse(job.suite),config.timeout,
          {mode:job.mode,credited:store.credited(job.entrant,job.problem)})
      })
        .catch(()=>({status:'SYSTEM_ERROR',variants:[]}))
        .then(result=>store.finish(job.id,result))
        .catch(error=>console.error('Job persistence failed:',error.code || error.name))
        .finally(()=>running.delete(task))
      running.add(task)
    }
  }

  const publicServer = makeServer(async (req,res) => {
    securityHeaders(res,config.production)
    try {
      if (!store) throw new HttpError(503,'Máy chủ đang khởi động.')
      const origin = config.origin || 'http://127.0.0.1:'+req.socket.localPort
      if (req.headers.host!==new URL(origin).host) throw new HttpError(421,'Host không hợp lệ.')
      const ip = clientAddress(req,config.trustTunnel)
      const url = new URL(req.url,origin)
      if (url.origin!==origin) unavailable()
      const path = url.pathname
      burst('global',150); burst('ip:'+ip,60)
      rate('global',12000); rate('ip:'+ip,2400)
      if (['GET','HEAD'].includes(req.method) && publicFiles.has(path)) return sendAsset(res,publicFiles.get(path),req.method==='HEAD')
      if (req.method==='GET' && path==='/healthz') return json(res,200,{ok:true})
      if (req.method==='GET' && path==='/api/room') {
        const {id,label,state}=store.room()
        return json(res,200,{id,label,state,inviteRequired:Boolean(config.joinCode)})
      }
      if (req.method==='POST') originGuard(req,origin)
      if (req.method==='POST' && (path==='/api/join' || path==='/api/recover')) {
        rate('access-global',220); rate('access:'+ip,80)
        const data = await jsonBody(req,2048)
        if (path==='/api/recover') {
          rate('recover:'+ip,20)
          if (typeof data.recovery!=='string' || !/^[\w-]{43}$/.test(data.recovery)) throw new HttpError(400,'Nhập mã khôi phục hợp lệ.')
          const {entrant,token}=store.recover(data.recovery)
          cookie(res,token)
          return json(res,200,{entrant})
        }
        if (store.authenticate(cookieToken(req))?.room===store.room().id) throw new HttpError(409,'Thoát phiên hiện tại trước khi đăng ký.')
        if (config.joinCode && !secureEqual(data.invite,config.joinCode)) throw new HttpError(403,'Mã vào phòng không hợp lệ.')
        if (!['individual','team'].includes(data.kind)) throw new HttpError(400,'Chọn cá nhân hoặc nhóm.')
        const {entrant,token}=store.join(data.kind,readName(data.name),config.maxEntrants)
        cookie(res,token)
        return json(res,201,{entrant})
      }
      const entrant = requireEntrant(req)
      rate('entrant:'+entrant.id,300)
      const pack=packs.get(store.room().pack)
      if (req.method==='GET') {
        if (path==='/api/me') return json(res,200,{entrant,room:store.room()})
        if (path==='/api/problems') return json(res,200,{version:pack.id,problems:Object.values(pack.rounds).map(roundSummary)})
        if (path.startsWith('/api/problems/')) {
          const id=path.slice('/api/problems/'.length)
          const problem=Object.hasOwn(pack.rounds,id)?pack.rounds[id]:null
          if (problem) return json(res,200,publicProblem(problem,pack))
        }
        if (path==='/api/leaderboard') return json(res,200,{rows:store.leaderboard()})
        if (path==='/api/jobs') return json(res,200,{jobs:store.recent(entrant),latestScores:store.latestScores(entrant)})
        if (path.startsWith('/api/jobs/')) {
          const id=path.slice('/api/jobs/'.length)
          const job=uuid.test(id) && store.job(entrant,id)
          if (job) return json(res,200,{job})
        }
      }
      if (req.method==='POST' && path==='/api/logout') {
        store.logout(cookieToken(req))
        cookie(res,'',0)
        return json(res,200,{ok:true})
      }
      if (req.method==='POST' && path==='/api/jobs') {
        rate('submit-global',500); rate('submit-ip:'+ip,140)
        const key=req.headers['idempotency-key']
        if (!uuid.test(key || '')) throw new HttpError(400,'Thiếu khóa lượt nộp hợp lệ.')
        const data=await jsonBody(req)
        const mode=data.mode ?? 'SCORE'
        if (!['SCORE','PREVIEW'].includes(mode)) throw new HttpError(400,'Chế độ không hợp lệ.')
        rate(mode+':'+entrant.id,mode==='PREVIEW'?6:12)
        const problem=typeof data.problem==='string' && Object.hasOwn(pack.rounds,data.problem)?pack.rounds[data.problem]:null
        if (!problem) throw new HttpError(404,'Đề không tồn tại.')
        if (data.version!==pack.id) throw new HttpError(409,'Phiên bản đề đã đổi. Tải lại trang.')
        let suite
        try {suite=prepareSuite(data,{operationSet:pack.operations,scenarioSet:pack.scenarios,preview:mode==='PREVIEW'})}
        catch(error) {throw new HttpError(400,error.message)}
        if (mode==='PREVIEW' && suite.length>4) throw new HttpError(400,'Chạy thử tối đa 4 test mỗi lượt.')
        const job=store.submit(entrant,problem.id,key,suite,config.maxQueue,mode,pack.id)
        pump()
        return json(res,job.reused?200:202,{job:{...job,state:store.job(entrant,job.id).state}})
      }
      unavailable()
    } catch(error) { responseError(error,res) }
  })

  const adminServer=makeServer(async (req,res) => {
    securityHeaders(res)
    try {
      if (!store) throw new HttpError(503,'Máy chủ đang khởi động.')
      const origin='http://127.0.0.1:'+req.socket.localPort
      if (req.headers.host!==new URL(origin).host) throw new HttpError(421,'Host không hợp lệ.')
      const url=new URL(req.url,origin)
      if (url.origin!==origin) unavailable()
      const path=url.pathname
      adminRate('admin',360)
      if (['GET','HEAD'].includes(req.method) && privateFiles.has(path)) return sendAsset(res,privateFiles.get(path),req.method==='HEAD')
      if (!secureEqual(req.headers.authorization,'Bearer '+config.adminKey)) {
        adminRate('unauthorized',12)
        throw new HttpError(401,'Khóa điều phối không hợp lệ.')
      }
      if (req.method==='GET' && path==='/api/admin/status') return json(res,200,store.stats())
      if (req.method==='GET' && path==='/api/admin/export') return json(res,200,store.exportResults())
      if (req.method==='POST' && path==='/api/admin/room') {
        if (req.headers.origin) originGuard(req,origin)
        const body=await jsonBody(req,2048)
        if (body.action==='open') return json(res,200,{room:store.changeRoom('OPEN')})
        if (body.action==='close') return json(res,200,{room:store.changeRoom('CLOSED')})
        if (body.action==='new') return json(res,201,{room:store.createRoom(readName(body.label))})
        throw new HttpError(400,'Thao tác không hợp lệ.')
      }
      unavailable()
    } catch(error) { responseError(error,res) }
  })
  const listen = (server,port) => new Promise((resolve,reject) => {
    server.once('error',reject)
    server.listen(port,loopback,resolve)
  })
  const stopListening = server => server.listening ? new Promise(resolve=>{server.close(resolve);server.closeIdleConnections()}) : Promise.resolve()
  try {
    await listen(publicServer,config.port)
    await listen(adminServer,config.adminPort)
    store=openStore(config.database,{currentPack:packs.current,legacyPack:packs.legacy,getPack:packs.get})
  } catch(error) {
    await Promise.all([stopListening(publicServer),stopListening(adminServer)])
    store?.close()
    throw error
  }
  const timer = setInterval(pump,300)
  timer.unref()
  pump()
  return {
    url:'http://127.0.0.1:'+publicServer.address().port,
    adminUrl:'http://127.0.0.1:'+adminServer.address().port,
    async close() {
      if (stopping) return
      stopping=true
      clearInterval(timer)
      await Promise.all([stopListening(publicServer),stopListening(adminServer),...running])
      store.close()
    }
  }
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const config=configFromEnv()
  const app=await launch(config)
  console.log('Activity: '+(config.origin || app.url))
  console.log('Operator: '+app.adminUrl)
  if (!process.env.ADMIN_KEY) console.log('Temporary operator key: '+config.adminKey)
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void app.close()})
}
