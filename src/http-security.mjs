import {timingSafeEqual} from 'node:crypto'
import {isIP} from 'node:net'
import {HttpError,digest} from './store.mjs'

export function secureEqual(left,right) {
  return typeof left==='string' && typeof right==='string' &&
    timingSafeEqual(Buffer.from(digest(left),'hex'),Buffer.from(digest(right),'hex'))
}
export function securityHeaders(res,production=false) {
  const headers = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()','Cache-Control':'no-store',
    'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin'
  }
  if (production) headers['Strict-Transport-Security']='max-age=31536000'
  for (const [key,value] of Object.entries(headers)) res.setHeader(key,value)
}
export function jsonResponse(res,status,value) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)})
  res.end(body)
}
export async function jsonBody(req,limit=32768) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415,'Dùng application/json.')
  if (Number(req.headers['content-length'])>limit) {
    req.resume()
    throw new HttpError(413,'Bài nộp quá lớn.')
  }
  const chunks = []
  let size = 0
  return new Promise((resolve,reject) => {
    const onData = chunk => {
      size += chunk.length
      if (size>limit) {
        req.removeListener('data',onData)
        req.resume()
        reject(new HttpError(413,'Bài nộp quá lớn.'))
      } else chunks.push(chunk)
    }
    req.on('data',onData)
    req.once('error',reject)
    req.once('end',() => {
      if (size>limit) return
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error()
        resolve(value)
      } catch { reject(new HttpError(400,'Nội dung JSON không hợp lệ.')) }
    })
  })
}
export function originGuard(req,origin) {
  if (req.headers.origin!==origin || req.headers['sec-fetch-site']==='cross-site') throw new HttpError(403,'Nguồn gửi yêu cầu không hợp lệ.')
}
export function clientAddress(req,trustTunnel) {
  const ip = req.headers['cf-connecting-ip']
  if (trustTunnel && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && typeof ip==='string' && isIP(ip)) return ip
  return req.socket.remoteAddress || 'unknown'
}
export function limiter({capacity=6000,period=60000}={}) {
  const keys = new Map()
  let clearAt = 0
  return (key,max) => {
    const now = Date.now()
    if (now>=clearAt) {
      for (const [k,row] of keys) if (row.until<=now) keys.delete(k)
      clearAt = now+period
    }
    let row = keys.get(key)
    if (!row || row.until<=now) {
      if (keys.size>=capacity && !keys.has(key)) throw new HttpError(429,'Máy chủ đang bận. Thử lại sau.')
      row = {until:now+period,count:0}
      keys.set(key,row)
    }
    if (++row.count>max) throw new HttpError(429,'Đã vượt giới hạn yêu cầu. Thử lại sau.')
  }
}
export function readName(value) {
  const name = typeof value==='string' ? value.normalize('NFKC').trim().replace(/ {2,}/g,' ') : ''
  if (name.length<2 || name.length>48 || !/^[\p{L}\p{M}\p{N} ._'’&()\-]+$/u.test(name)) {
    throw new HttpError(400,'Tên cần từ 2 đến 48 ký tự và chỉ dùng chữ, số hoặc dấu tên thông dụng.')
  }
  return name
}
