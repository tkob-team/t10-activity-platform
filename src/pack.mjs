import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {problems,revision,fixture,scenarios,operations,enums} from './catalog.mjs'

const sha=data=>createHash('sha256').update(data).digest('hex')
const legacyVersion='eshop-1be4637-v1'
function legacyRounds() {
  return Object.fromEntries(problems.map(({id,title,level,intro,rules,mutants,minScore})=>[id,{id,title,level,intro,rules,mutants,minScore}]))
}
export function loadPack(path) {
  const pack=JSON.parse(readFileSync(path,'utf8'))
  if (!pack.rounds) {
    Object.assign(pack,{version:legacyVersion,rounds:legacyRounds(),fixture,scenarios:{standard:scenarios.standard},operations,enums})
  }
  if (pack.revision!==revision || sha(pack.baseline.source)!==pack.baseline.sha256 ||
      sha(pack.baseline.database)!==pack.baseline.databaseSha256 ||
      problems.some(({id})=>{
        const round=pack.rounds[id]
        return !round || !pack.starters[id] || !Number.isInteger(round.minScore) || round.minScore<1 ||
          !Array.isArray(round.mutants) || round.minScore>round.mutants.length ||
          new Set(round.mutants).size!==round.mutants.length ||
          round.mutants.some(key=>!pack.variants[key] || sha(pack.variants[key].source)!==pack.variants[key].sha256)
      })) throw new Error('SUT pack integrity check failed')
  if (!pack.fixture || !pack.scenarios?.standard || !pack.operations || !pack.enums) throw new Error('Missing pack interface')
  Object.defineProperty(pack,'id',{value:sha(JSON.stringify(pack))})
  return pack
}
export function openPackRegistry(currentPath,legacyPath) {
  const packs=new Map()
  const archive=resolve(dirname(currentPath),'packs')
  mkdirSync(archive,{recursive:true,mode:0o700})
  function keep(pack) {
    const filename=resolve(archive,pack.id+'.json')
    try {writeFileSync(filename,JSON.stringify(pack),{flag:'wx',mode:0o600})}
    catch(error) {if (error.code!=='EEXIST') throw error}
    packs.set(pack.id,pack)
    return pack
  }
  const current=keep(loadPack(currentPath))
  const legacy=legacyPath && existsSync(legacyPath)?keep(loadPack(legacyPath)):null
  return {
    current,legacy,
    get(id) {
      if (!/^[0-9a-f]{64}$/.test(id || '')) throw new Error('Room pack is missing')
      if (!packs.has(id)) {
        const pack=loadPack(resolve(archive,id+'.json'))
        if (pack.id!==id) throw new Error('Archived pack fingerprint mismatch')
        packs.set(id,pack)
      }
      return packs.get(id)
    }
  }
}
export function roundSummary(round) {
  const {id,title,level,intro,minScore}=round
  return {id,title,level,intro,minScore,total:round.mutants.length}
}
export function publicProblem(round,pack) {
  return {...roundSummary(round),rules:round.rules,version:pack.id,revision:pack.revision,
    fixture:pack.fixture,scenarios:pack.scenarios,operations:pack.operations,enums:pack.enums,
    source:[{name:'server.js',text:pack.baseline.source},{name:'database.js',text:pack.baseline.database}],
    starter:pack.starters[round.id]}
}
