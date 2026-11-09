import {DatabaseSync} from 'node:sqlite'
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'

const [source,target] = process.argv.slice(2)
if (!source || !target || !existsSync(resolve(source)) || existsSync(resolve(target))) {
  throw new Error('Usage: node scripts/backup.mjs <existing-database> <new-backup>')
}
const db=new DatabaseSync(resolve(source),{readOnly:true})
try {
  db.exec('PRAGMA busy_timeout=3000')
  db.prepare('VACUUM INTO ?').run(resolve(target))
} finally { db.close() }
console.log('Backup written to ' + resolve(target))
