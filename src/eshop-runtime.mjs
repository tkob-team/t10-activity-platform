import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'
import {validArgument} from './submission.mjs'

const require = createRequire(import.meta.url)
const nativeSqlite = require('sqlite3')
const express = require('express')
const jwt = require('jsonwebtoken')
const run = (db,sql,args=[]) => new Promise((resolve,reject) =>
  db.run(sql,args,function(error){ if (error) reject(error); else resolve(this.lastID) }))
const get = (db,sql,args=[]) => new Promise((resolve,reject) =>
  db.get(sql,args,(error,row) => error ? reject(error) : resolve(row)))

// Only pinned course source is loaded here. Player submissions are already data.
function loadPinned(source, dependencies, Clock) {
  const mod = {exports:{}}
  const localRequire = name => {
    if (!Object.hasOwn(dependencies,name)) throw new Error('Unexpected SUT dependency')
    return dependencies[name]
  }
  new Function('require','module','exports','__dirname','Date',source)(localRequire,mod,mod.exports,'.',Clock)
  return mod.exports
}
function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['password','token','resetToken','reset_token'].includes(key)).map(([key,item]) => [key,redact(item)]))
  return value
}
export async function fixtureRuntime(source,database,{fixture,scenarios,operations},scenario='standard') {
  const startTime=Date.parse(fixture.start)
  const preset=scenarios[scenario]
  if (!preset) throw new Error('Unknown fixture scenario')
  let minute = 0
  let app
  const sqlite = { Database: class extends nativeSqlite.Database {
    constructor(_path,...args) { super(':memory:',...args) }
  }}
  sqlite.verbose = () => sqlite
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [Clock.now()])) }
    static now() { return startTime + minute*60000 }
  }
  const wrappedExpress = () => {
    app = express()
    app.listen = () => ({close(){}})
    return app
  }
  const db = loadPinned(database,{sqlite3:sqlite,path:require('node:path')},Clock)
  let server
  try {
    loadPinned(source,{express:wrappedExpress,cors:require('cors'),'body-parser':require('body-parser'),
      './database':db,jsonwebtoken:jwt},Clock)
    await get(db,'SELECT COUNT(*) AS n FROM coupons')
    const signingKey = /const SECRET_KEY = "([^"]+)";/.exec(source)?.[1]
    if (!app || !signingKey) throw new Error('Fixture adapter cannot initialize')
    const accounts = {}
    for (const [name,row] of Object.entries(fixture.accounts)) {
      const id = name === 'admin'
        ? (await get(db,'SELECT id FROM users WHERE email=?',[row.email])).id
        : await run(db,'INSERT INTO users(name,email,password,locked_until) VALUES (?,?,?,?)',
          [name,row.email,row.password,name==='bob'?new Date(startTime+preset.bobLockMinute*60000).toISOString():null])
      accounts[name] = {id,email:row.email,token:jwt.sign({id,role:name==='admin'?'admin':'user'},signingKey)}
    }
    const c = fixture.coupon
    await run(db,'INSERT INTO coupons(code,type,discount_value,min_order_amount,expired_at,is_active,max_uses_per_user) VALUES (?,?,?,?,?,?,?)',
      [c.code,'fixed',c.discount,c.min,new Date(startTime+preset.expiryMinute*60000).toISOString(),1,preset.maxUses])
    const guard = randomBytes(24).toString('hex')
    server = createServer((req,res) => {
      if (req.headers['x-fixture-key'] !== guard) { res.writeHead(404); res.end(); return }
      app(req,res)
    })
    await new Promise((resolve,reject) => {
      server.once('error',reject)
      server.listen(0,'127.0.0.1',resolve)
    })
    const url = 'http://127.0.0.1:' + server.address().port
    async function request(method,endpoint,actor,body) {
      const headers = {'x-fixture-key':guard}
      if (actor) headers.authorization = 'Bearer ' + accounts[actor].token
      if (body) headers['content-type'] = 'application/json'
      const response = await fetch(url + endpoint,{method,headers,body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(1300)})
      if (response.status>=500) throw new Error('SUT returned a server error')
      const text = await response.text()
      let parsed = null
      if (text) { try { parsed = JSON.parse(text) } catch { throw new Error('SUT returned malformed response') } }
      return {status:response.status,body:redact(parsed)}
    }
    const calls = {
      cart: a => request('GET','/api/cart',a),
      addItem: (a,id,quantity,price) => request('POST','/api/cart',a,{id,quantity,price}),
      checkout: (a,total_amount,shipping_address) => request('POST','/api/checkout',a,{total_amount,shipping_address}),
      orders: a => request('GET','/api/orders/my-orders',a),
      cancel: (a,id) => request('PUT','/api/orders/'+id+'/cancel',a),
      order: id => request('GET','/api/orders/'+id),
      couponList: a => request('GET','/api/coupons',a),
      createCoupon: (a,code,type,discount_value,min_order_amount,expiry,max_uses_per_user) =>
        request('POST','/api/admin/coupons',a,{code,type,discount_value,min_order_amount,max_uses_per_user,
          expired_at:new Date(startTime+expiry*60000).toISOString()}),
      applyCoupon: (code,total_amount,a) => request('POST','/api/apply-coupon',null,
        {code,total_amount,...(a==='guest'?{}:{user_id:accounts[a].id})}),
      recordCoupon: (a,coupon_id) => request('POST','/api/coupon-usage',a,{coupon_id}),
      login: (a,password) => request('POST','/api/login',null,{email:accounts[a].email,password}),
      profile: a => request('GET','/api/users/me',a),
      setClock: value => { minute=value; return {status:200,body:{minute}} }
    }
    return {
      async call(op,args) {
        const params = operations[op].args
        if (!params.every((spec,i)=>validArgument(spec,args[i]))) throw new Error('Lời gọi có tham số không đúng kiểu.')
        return calls[op](...args)
      },
      async close() { await close() }
    }
  } catch (error) {
    await close()
    throw error
  }
  async function close() {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await new Promise(resolve => db.close(resolve))
  }
}
