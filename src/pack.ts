import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonical(value: any): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
  })
}

export function loadPack(path = process.env.SUT_PACK_FILE || '.runtime/pack.json') {
  const bytes = readFileSync(path)
  const pack = JSON.parse(bytes.toString('utf8'))
  const ids = Object.values(pack.sections).flatMap((feature: any) => feature.mutants)
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.length !== Object.keys(pack.variants).length ||
      sha(pack.baseline.source) !== pack.baseline.sha256 || sha(pack.baseline.database) !== pack.baseline.databaseSha256 ||
      ids.some(id => !Object.hasOwn(pack.variants, id) || sha(pack.variants[id].source) !== pack.variants[id].sha256) ||
      ids.some(id => pack.variants[id].feature !== pack.catalog[id]?.feature)) {
    throw new Error('Private pack integrity check failed')
  }
  return { ...pack, id: sha(bytes) }
}

export function publicPack(pack: ReturnType<typeof loadPack>) {
  return {
    revision: pack.revision, packHash: pack.id, scenarios: pack.scenarios, fixture: pack.fixture,
    operations: pack.operations, enums: pack.enums,
    features: Object.values(pack.sections).map(({ id, title, intro, rules }: any) => ({
      id, title, intro, rules, starters: pack.starters[id]
    })),
    source: [{ name: 'server.js', text: pack.baseline.source }, { name: 'database.js', text: pack.baseline.database }]
  }
}
