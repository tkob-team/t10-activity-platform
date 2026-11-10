import {execFileSync} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {features,revision,packVersion,fixture,scenarios,operations,enums} from '../src/catalog.mjs'
import {controls} from '../test/controls.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const sut=resolve(process.env.SUT_REPO || resolve(root,'../eshop-sut_T10_Mutation_Testing_and_Test_Effectiveness'))
const evidence=resolve(process.env.SUT_EVIDENCE || resolve(root,'../T10_Mutation_Testing_and_Test_Effectiveness/evidence/verification/source-audit-2026-11-06/mutation'))
const output=resolve(process.env.SUT_PACK_FILE || resolve(root,'.runtime/pack.json'))
const sha=data=>createHash('sha256').update(data).digest('hex')
const read=name=>execFileSync('git',['-C',sut,'show',revision+':backend/'+name],{encoding:'utf8'}).replace(/\r\n/g,'\n')
const source=read('server.js'),database=read('database.js')
const starters=Object.fromEntries(features.map(p=>[p.id,p.files.map(file=>({name:file,text:read(file)}))]))
const variants={},sections={},catalog={}
const lines=source.split('\n')
const offset=point=>lines.slice(0,point.line-1).reduce((n,line)=>n+line.length+1,0)+point.column-1
for (const problem of features) {
  const mutants=Object.keys(controls).filter(id=>id.startsWith(problem.id+'-'))
  const report=JSON.parse(readFileSync(resolve(evidence,problem.domain+'-baseline/mutation.json'),'utf8'))
  const file=report.files['server.js']
  if (file?.source.replace(/\r\n/g,'\n')!==source) throw new Error('Audit source does not match '+problem.id)
  const ids=[],seen=new Set()
  const candidates=file.mutants.filter(hit=>['Survived','NoCoverage'].includes(hit.status) && problem.ranges.some(([start,end])=>
    hit.location.start.line>=start && hit.location.end.line<=end))
  // Give the audit controls their original IDs if two report entries yield identical source.
  candidates.sort((a,b)=>Number(mutants.includes(problem.id+'-'+b.id))-Number(mutants.includes(problem.id+'-'+a.id)))
  for (const hit of candidates) {
    const id=problem.id+'-'+hit.id
    const a=offset(hit.location.start),b=offset(hit.location.end)
    if (a<0 || b<=a || b>source.length) throw new Error('Invalid mutation location for '+id)
    const mutated=source.slice(0,a)+hit.replacement+source.slice(b)
    const hash=sha(mutated)
    if (mutated===source || seen.has(hash)) continue
    seen.add(hash)
    ids.push(id)
    const metadata={location:hit.location,mutator:hit.mutatorName,reportId:String(hit.id),baselineStatus:hit.status,sha256:hash}
    catalog[id]={...metadata,feature:problem.id}
    if (mutants.includes(id)) variants[id]={...metadata,feature:problem.id,source:mutated}
  }
  if (mutants.some(id=>!ids.includes(id))) throw new Error('Missing audit controls for '+problem.id)
  const {id,title,intro,rules}=problem
  sections[id]={id,title,intro,rules,mutants}
}
const pack={version:packVersion,revision,baseline:{source,database,sha256:sha(source),databaseSha256:sha(database)},
  sections,variants,starters,fixture,scenarios,operations,enums,catalog}
mkdirSync(dirname(output),{recursive:true})
writeFileSync(output,JSON.stringify(pack),{mode:0o600})
console.log(Object.keys(catalog).length+' catalog candidates, '+Object.keys(variants).length+' proposed scoring variants')
console.log('Prepared private pack at '+output)
