import {fork} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {loadPack} from './pack.mjs'

export {loadPack}
const entry=fileURLToPath(new URL('./judge-worker.mjs',import.meta.url))
export function runVariant(pinned,variant,suite,timeout=9000) {
  const pack=typeof pinned==='string'?loadPack(pinned):pinned
  const source=variant?pack.variants[variant]?.source:pack.baseline.source
  if (!source) return Promise.resolve({status:'RUN_ERROR'})
  return new Promise(resolve=>{
    const env={}
    for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME','USERPROFILE']) {
      if (process.env[key]) env[key]=process.env[key]
    }
    const child=fork(entry,[],{env,execArgv:['--max-old-space-size=128'],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true})
    let outcome=null
    const timer=setTimeout(()=>{outcome={status:'TIMEOUT'}; child.kill('SIGKILL')},timeout)
    child.on('message',message=>{
      if (!outcome && ['PASS','ASSERTION','RUN_ERROR','TIMEOUT'].includes(message?.status)) outcome=message
    })
    child.once('error',()=>{clearTimeout(timer); resolve({status:'RUN_ERROR'})})
    child.once('exit',code=>{
      clearTimeout(timer)
      resolve(outcome?.status==='TIMEOUT' || (code===0 && outcome)?outcome:{status:'RUN_ERROR'})
    })
    child.send({source,database:pack.baseline.database,suite,trace:!variant,
      context:{fixture:pack.fixture,scenarios:pack.scenarios,operations:pack.operations}},error=>{if (error) child.kill()})
  })
}
export async function judge(pinned,problem,suite,timeout,{mode='SCORE',credited=[]}={}) {
  const pack=typeof pinned==='string'?loadPack(pinned):pinned
  const original=await runVariant(pack,null,suite,timeout)
  if (mode==='PREVIEW') return {status:'PREVIEW',original,variants:[]}
  if (original.status!=='PASS') return {
    status:original.status==='ASSERTION'?'ORIGINAL_FAILED':original.status,original,variants:[]
  }
  const known=new Set(credited)
  const candidates=problem.mutants.filter(id=>!known.has(id))
  const variants=[]
  // Bound subprocesses to two per queued job even with the expanded bank.
  for (let i=0;i<candidates.length;i+=2) {
    const chunk=await Promise.all(candidates.slice(i,i+2).map(async id=>{
      const result=await runVariant(pack,id,suite,timeout)
      return {id,status:result.status==='ASSERTION'?'KILLED':result.status==='PASS'?'SURVIVED':result.status}
    }))
    variants.push(...chunk)
  }
  return {status:'GRADED',original,variants,alreadyCredited:problem.mutants.length-candidates.length}
}
