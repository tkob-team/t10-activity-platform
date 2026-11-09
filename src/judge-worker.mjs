import {isDeepStrictEqual} from 'node:util'
import {fixtureRuntime} from './eshop-runtime.mjs'
import {readResult,resolveValue} from './submission.mjs'
import {loadPack} from './pack.mjs'

const clip=value=>{
  const text=String(JSON.stringify(value)??'undefined')
  return text.length>360?text.slice(0,357)+'...':text
}
function passed(step,actual,expected) {
  if (step.matcher==='toBe') return Object.is(actual,expected)
  if (step.matcher==='toEqual') return isDeepStrictEqual(actual,expected)
  return typeof actual==='number' && typeof expected==='number' &&
    (step.matcher==='toBeGreaterThan'?actual>expected:actual<expected)
}

export async function executeSuite(suite,source,database,context,{trace=false}={}) {
  const results=[]
  let firstFailure
  let errorStatus
  for (const test of suite) {
    const row={id:test.id,name:test.name,scenario:test.scenario,status:'PASS',outputs:[]}
    const values=new Map()
    let runtime
    try {
      runtime=await fixtureRuntime(source,database,context,test.scenario)
      for (const step of test.steps) {
        if (step.kind==='call') {
          const result=await runtime.call(step.op,step.args.map(value=>resolveValue(values,value)))
          values.set(step.as,result)
          if (trace && row.outputs.length<12) row.outputs.push({ref:step.as,operation:step.op,http:result.status,body:clip(result.body)})
          continue
        }
        const actual=readResult(values,step.actual)
        const expected=resolveValue(values,step.expected)
        if (!passed(step,actual,expected)) {
          row.status='ASSERTION'
          row.failure={test:test.name,path:step.actual,expected:clip(expected),actual:clip(actual)}
          firstFailure ??= row.failure
          break
        }
      }
    } catch(error) {
      row.status=error.name==='TimeoutError'?'TIMEOUT':'RUN_ERROR'
      errorStatus ??= row.status
    } finally {
      if (runtime) {
        try {await runtime.close()} catch {
          if (row.status==='PASS') {row.status='RUN_ERROR'; errorStatus ??= row.status}
        }
      }
    }
    if (trace) results.push(row)
    // A confirmed failed assertion on a mutant is enough. Later steps cannot erase it.
    else if (firstFailure) return {status:'ASSERTION'}
  }
  const status=errorStatus || (firstFailure?'ASSERTION':'PASS')
  return {status,tests:suite.length,...(firstFailure?{failure:firstFailure}:{}),...(trace?{results}:{})}
}

if (process.send) {
  console.log=()=>{}
  process.once('message',async ({source,database,suite,context,trace,packPath,variant})=>{
    try {
      if (packPath) {
        const pack=loadPack(packPath)
        source=variant?pack.variants[variant]?.source:pack.baseline.source
        database=pack.baseline.database
        context=pack
      }
      process.send(await executeSuite(suite,source,database,context,{trace}))
    }
    catch(error) {process.send({status:error.name==='TimeoutError'?'TIMEOUT':'RUN_ERROR'})}
    finally {process.disconnect()}
  })
}
