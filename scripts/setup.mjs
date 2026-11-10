import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const names = ['LAB_DB_PASSWORD', 'LAB_ADMIN_KEY', 'LAB_EXECUTOR_KEY']
const lines = names.map(name => name + '=' + randomBytes(32).toString('hex'))
try {
  writeFileSync('.env', lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  console.log('Created local .env. Read LAB_ADMIN_KEY there to open Host Console.')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.log('Local .env already exists.')
}
