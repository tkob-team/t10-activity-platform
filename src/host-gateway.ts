import { createServer, request, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'

const key = process.env.ADMIN_KEY ?? ''
const port = process.env.ADMIN_PORT || '8788'
const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port])
if (key.length < 32) throw new Error('Missing host key')

function error(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: message }))
}

createServer((req, res) => {
  const host = req.headers.host?.toLowerCase() ?? ''
  const { origin, 'sec-fetch-site': site } = req.headers
  if (!allowedHosts.has(host) || (origin && origin !== 'http://' + host) ||
      (site && site !== 'same-origin' && site !== 'none')) {
    return error(res, 403, 'Nguồn yêu cầu không hợp lệ.')
  }
  if (!req.url?.startsWith('/') || req.url.startsWith('//') || !['GET', 'HEAD', 'POST'].includes(req.method ?? '')) {
    return error(res, 400, 'Yêu cầu không hợp lệ.')
  }

  const headers: OutgoingHttpHeaders = { host, authorization: 'Bearer ' + key }
  for (const name of ['accept', 'content-type', 'content-length', 'origin', 'sec-fetch-site']) {
    const value = req.headers[name]
    if (value !== undefined) headers[name] = value
  }
  const upstream = request({ hostname: 'web', port: 8788, method: req.method, path: req.url, headers }, reply => {
    res.writeHead(reply.statusCode ?? 502, reply.headers)
    reply.on('error', () => res.destroy())
    reply.pipe(res)
  })
  upstream.setTimeout(15000, () => upstream.destroy(new Error('Host request timed out')))
  upstream.on('error', () => {
    if (res.headersSent) res.destroy()
    else if (!res.destroyed) error(res, 502, 'Chưa kết nối được máy chấm.')
  })
  res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
  req.pipe(upstream)
}).listen(8788)
