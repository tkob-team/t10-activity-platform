import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {configFromEnv,launch} from '../src/server.mjs'
import {packVersion} from '../src/catalog.mjs'
import {controls} from './controls.mjs'

const key='operator-test-abcdefghijklmnopqrstuvwx'
async function request(origin,path,{body,token,authorization,headerOrigin=origin,headers={}}={}) {
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{
    ...(token?{cookie:token}:{}),...(authorization?{authorization:'Bearer '+authorization}:{}),
    ...(body===undefined?{}:{'content-type':'application/json',origin:headerOrigin}),...headers
  },body:body===undefined?undefined:JSON.stringify(body)})
  const data=await response.json()
  return {status:response.status,data,headers:response.headers,token:response.headers.get('set-cookie')?.split(';')[0]}
}
async function awaitJob(app,token,id) {
  for (let n=0;n<65;n++) {
    const r=await request(app.url,'/api/jobs/'+id,{token})
    assert.equal(r.status,200)
    if (r.data.job.state==='DONE') return r.data.job.result
    await delay(350)
  }
  assert.fail('Job did not finish')
}
test('public room, access controls, SQL input, persistent recovery, queue and server-owned ranking',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'t10-http-'))
  assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'t10-http-'))
  const config={...configFromEnv({}),port:0,adminPort:0,adminKey:key,database:join(dir,'room.sqlite')}
  let app=await launch(config)
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true})})
  const player=(path,options)=>request(app.url,path,options)
  const operator=(path,body)=>request(app.adminUrl,path,{authorization:key,body})
  assert.equal((await player('/api/room')).data.state,'SETUP')
  assert.equal((await player('/api/join',{body:{name:'Thái Hòa',kind:'individual'}})).status,409)
  assert.equal((await request(app.adminUrl,'/api/admin/status')).status,401)
  assert.notEqual((await player('/api/admin/status',{authorization:key})).status,200)
  assert.equal((await operator('/api/admin/room',{action:'open'})).status,200)
  assert.equal((await player('/api/join',{headerOrigin:'https://attacker.invalid',body:{name:'Cross site',kind:'individual'}})).status,403)
  assert.equal((await player('/api/join',{body:{name:"x'); DROP TABLE entrants;--",kind:'team'}})).status,400)
  const team=await player('/api/join',{body:{name:"O'Connor",kind:'team'}})
  const solo=await player('/api/join',{body:{name:'Thái Hòa',kind:'individual'}})
  assert.equal(team.status,201)
  assert.equal(solo.status,201)
  assert.equal(team.data.entrant.assigned,'orders')
  assert.equal(solo.data.entrant.assigned,'coupons')
  assert.match(team.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/)
  assert.match(team.headers.get('content-security-policy'),/frame-ancestors 'none'/)
  assert.equal((await player('/api/join',{body:{name:"o'connor",kind:'individual'}})).status,409)
  const problem=await player('/api/problems/orders',{token:team.token})
  assert.equal(problem.status,200)
  assert.ok(problem.data.source.some(file=>file.text.includes('app.get')))
  assert.equal(Object.hasOwn(problem.data,'variants'),false)
  assert.equal(Object.hasOwn(problem.data,'mutants'),false)
  assert.equal((await player('/.runtime/eshop/pack.json',{token:team.token})).status,404)
  const body={problem:'orders',version:packVersion,builder:[],code:controls['orders-68'],score:999}
  const submit=(token,idempotency,content=body)=>player('/api/jobs',{token,body:content,headers:{'idempotency-key':idempotency}})
  assert.equal((await submit(team.token,randomUUID(),{...body,code:'x'.repeat(33000)})).status,413)
  const idempotency=randomUUID()
  const first=await submit(team.token,idempotency)
  assert.equal(first.status,202)
  const id=first.data.job.id
  assert.equal((await submit(team.token,idempotency)).data.job.id,id)
  assert.equal((await submit(team.token,idempotency,{...body,code:controls['orders-4']})).status,409)
  assert.equal((await player('/api/jobs/'+id,{token:solo.token})).status,404)
  const score=await awaitJob(app,team.token,id)
  assert.equal(score.newPoints,1,JSON.stringify(score))
  const retry=await submit(team.token,randomUUID())
  assert.equal((await awaitJob(app,team.token,retry.data.job.id)).newPoints,0)
  assert.equal((await player('/api/leaderboard',{token:team.token})).data.rows[0].score,1)
  let status
  for (let i=0;i<14;i++) status=(await submit(team.token,randomUUID(),{...body,code:'process.exit()'})).status
  assert.equal(status,429)
  await app.close()
  app=await launch(config)
  assert.equal((await player('/api/me',{token:team.token})).data.entrant.name,"O'Connor")
  assert.equal((await player('/api/leaderboard',{token:team.token})).data.rows[0].score,1)
  const recovered=await player('/api/recover',{body:{recovery:team.data.recovery}})
  assert.equal(recovered.status,200)
  assert.equal((await player('/api/me',{token:team.token})).status,401)
  assert.equal((await player('/api/me',{token:recovered.token})).data.entrant.id,team.data.entrant.id)
  assert.equal((await operator('/api/admin/room',{action:'close'})).status,200)
  assert.equal((await submit(recovered.token,randomUUID())).status,409)
  const exported=await operator('/api/admin/export')
  assert.equal(exported.data.leaderboard[0].score,1)
  assert.equal(exported.data.results.length,2)
})
test('production requires exact HTTPS origin and private operator key',()=>{
  assert.throws(()=>configFromEnv({NODE_ENV:'production'}))
  assert.throws(()=>configFromEnv({NODE_ENV:'production',APP_ORIGIN:'http://example.test',ADMIN_KEY:key}))
  assert.equal(configFromEnv({NODE_ENV:'production',APP_ORIGIN:'https://example.test',ADMIN_KEY:key}).production,true)
})

test('12 concurrent entrants retain accepted jobs and scores when the room closes',async t=>{
  const app=await launch({...configFromEnv({}),port:0,adminPort:0,adminKey:key,database:':memory:',workers:2})
  t.after(()=>app.close())
  const operator=(path,body)=>request(app.adminUrl,path,{authorization:key,body})
  await operator('/api/admin/room',{action:'open'})
  const entrants=await Promise.all(Array.from({length:12},(_,i)=>request(app.url,'/api/join',{
    body:{name:'Pilot '+i,kind:i%2?'team':'individual'}
  })))
  const assignments={}
  const controlByProblem={orders:'orders-4',coupons:'coupons-33',auth:'auth-32'}
  const start=performance.now()
  const submissions=await Promise.all(entrants.map(entrant=>{
    assert.equal(entrant.status,201)
    const problem=entrant.data.entrant.assigned
    assignments[problem]=(assignments[problem]||0)+1
    return request(app.url,'/api/jobs',{token:entrant.token,headers:{'idempotency-key':randomUUID()},
      body:{problem,version:packVersion,builder:[],code:controls[controlByProblem[problem]]}})
  }))
  assert.deepEqual(assignments,{orders:4,coupons:4,auth:4})
  assert.ok(submissions.every(entry=>entry.status===202),JSON.stringify(submissions.map(entry=>entry.status)))
  assert.equal((await operator('/api/admin/room',{action:'close'})).status,200)
  const times=await Promise.all(submissions.map(async (submission,i)=>{
    const result=await awaitJob(app,entrants[i].token,submission.data.job.id)
    assert.equal(result.newPoints,1,JSON.stringify(result))
    return Math.round(performance.now()-start)
  }))
  assert.ok((await operator('/api/admin/export')).data.leaderboard.every(row=>row.score===1&&row.rank===1))
  t.diagnostic('All 12 local jobs completed in '+Math.max(...times)+' ms from start of concurrent submissions.')
})
