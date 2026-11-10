import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [mode, destination, flag, project] = process.argv.slice(2)
if (!['save','restore'].includes(mode) || !destination ||
    ((flag || project) && (flag !== '--project' || !/^[a-z][a-z0-9_-]+$/.test(project ?? ''))) ||
    (mode === 'restore' && (!project || project === 't10-mutation-lab'))) {
  throw new Error('Usage: node scripts/backup.mjs save|restore DIRECTORY [--project COMPOSE_PROJECT]; restore requires an isolated project')
}
const folder = resolve(destination)
const hash = data => createHash('sha256').update(data).digest('hex')
function pg(args, input) {
  const projectArgs = project ? ['-p',project] : []
  const command = spawnSync('docker', ['compose',...projectArgs,'exec','-T','db',...args], {
    input, timeout:60000, maxBuffer:32*1024*1024
  })
  if (command.status !== 0) throw new Error(command.error?.message || String(command.stderr))
  return command.stdout
}
if (mode === 'save') {
  const pack = readFileSync('.runtime/pack.json')
  const snapshot = pg(['pg_dump','-U','lab','-d','lab','-Fc'])
  const manifest = { pack:hash(pack), database:hash(snapshot), createdAt:new Date().toISOString() }
  mkdirSync(folder, { mode:0o700 })
  writeFileSync(join(folder,'lab.dump'),snapshot,{flag:'wx',mode:0o600})
  writeFileSync(join(folder,'pack.json'),pack,{flag:'wx',mode:0o600})
  writeFileSync(join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
  console.log('Backup verified:', JSON.stringify(manifest))
} else {
  const manifest = JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'))
  const pack = readFileSync(join(folder,'pack.json'))
  const database = readFileSync(join(folder,'lab.dump'))
  if (hash(pack) !== manifest.pack || hash(database) !== manifest.database ||
      hash(readFileSync('.runtime/pack.json')) !== manifest.pack) throw new Error('Backup checksum or mounted pack mismatch')
  const tables = pg(['psql','-U','lab','-d','lab','-Atc',"SELECT count(*) FROM pg_tables WHERE schemaname='public'"]).toString().trim()
  if (tables !== '0') throw new Error('Restore target must have no application tables')
  pg(['pg_restore','-U','lab','-d','lab','--no-owner','--single-transaction','--exit-on-error'],database)
  console.log('Restore completed with verified input checksums.')
}
