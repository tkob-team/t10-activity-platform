import test from 'node:test'
import assert from 'node:assert/strict'
import {configFromEnv} from '../src/server.mjs'
import {loadPack,runVariant,judge} from '../src/judge.mjs'
import {prepareSuite} from '../src/submission.mjs'
import {problems} from '../src/catalog.mjs'
import {controls} from './controls.mjs'

const {packPath}=configFromEnv()
test('all five audited survivors are distinct and have working original/mutant assertion controls',async t=>{
  const pack=loadPack(packPath)
  assert.equal(Object.keys(pack.variants).length,5)
  for (const [id,code] of Object.entries(controls)) await t.test(id,async()=>{
    const suite=prepareSuite({builder:[],code})
    const original=await runVariant(packPath,null,suite)
    const mutant=await runVariant(packPath,id,suite)
    assert.equal(original.status,'PASS',JSON.stringify(original))
    assert.equal(mutant.status,'ASSERTION',JSON.stringify(mutant))
  })
})
test('original failure short-circuits variants and invalid reference is runtime error',async()=>{
  const problem=problems[0]
  const failure=prepareSuite({builder:[],code:"test('bad',async()=>{const r=await sut.cart('alice');expect(r.status).toBe(401)})"})
  const result=await judge(packPath,problem,failure)
  assert.equal(result.status,'ORIGINAL_FAILED')
  assert.deepEqual(result.variants,[])
  const error=prepareSuite({builder:[],code:"test('bad ref',async()=>{const r=await sut.cart('alice');const o=await sut.order(r.body.orderId);expect(o.status).toBe(200)})"})
  assert.equal((await judge(packPath,problem,error)).status,'RUN_ERROR')
})
test('builder and code normalize to the same bounded execution model',()=>{
  const suite=prepareSuite({builder:[{name:'empty',steps:[
    {kind:'call',as:'r1',op:'cart',args:['alice']},
    {kind:'assert',actual:'r1.body.length',matcher:'toBe',expected:0}
  ]}],code:controls['orders-68']})
  assert.equal(suite.length,2)
  assert.equal(suite[1].steps[1].args[1].ref,'created.body.orderId')
})
test('untrusted code cannot access host APIs or synthesize raw verdicts',()=>{
  for (const code of [
    "import fs from 'node:fs'",
    "test('x',()=>{while(true){}})",
    "test('x',()=>{const r=process.exit(0);expect(r).toBe(0)})",
    "test('x',()=>{const r=sut.cart('alice');expect(r.constructor).toBe(0)})",
    "test('x',()=>{const r=await sut['cart']('alice');expect(r.status).toBe(200)})",
    "test('x',()=>expect(1).toBe(2))",
    "test('x',()=>{console.log('KILLED')})"
  ]) assert.throws(()=>prepareSuite({builder:[],code}))
  assert.throws(()=>prepareSuite({builder:[{name:'bad',steps:[
    {kind:'call',as:'r1',op:'constructor',args:[]},{kind:'assert',actual:'r1',matcher:'toBe',expected:1}
  ]}],code:''}))
})
