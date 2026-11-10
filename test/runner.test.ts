import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareSuite } from '../src/submission.mjs'
import { loadPack } from '../src/pack.ts'
import { runVariant } from '../src/runner.ts'
import { controls } from './controls.mjs'

test('pinned EShop passes original and has a real kill control for every scored variant', async () => {
  const pack = loadPack()
  assert.equal(Object.keys(pack.catalog).length, 81)
  assert.deepEqual(Object.keys(pack.variants).sort(), Object.keys(controls).sort())
  const suites = new Map<string, ReturnType<typeof prepareSuite>>()
  for (const code of new Set(Object.values(controls))) {
    const suite = prepareSuite({ builder: [], code })
    const original = await runVariant(null, suite)
    assert.equal(original.outcome, 'ALL_PASS', JSON.stringify({ test: suite[0].name, original }))
    suites.set(code, suite)
  }
  const entries = Object.entries(controls)
  const failures: unknown[] = []
  async function qualify(slot: number) {
    for (let i = slot; i < entries.length; i += 2) {
      const [id, code] = entries[i]
      const mutant = await runVariant(id, suites.get(code))
      if (mutant.outcome !== 'ASSERTION_MISMATCH' || !mutant.failure?.testId) failures.push({ id, ...mutant })
      console.log(JSON.stringify({ id, outcome: mutant.outcome, mutant: mutant.durationMs, failure: mutant.failure }))
    }
  }
  await Promise.all([qualify(0), qualify(1)])
  assert.deepEqual(failures, [])
})

test('judge distinguishes an original assertion, a survivor and a timeout', async () => {
  const code = "test('Empty cart', async () => { const cart = await sut.cart('alice'); expect(cart.body.length).toBe(0); })"
  const suite = prepareSuite({ builder: [], code })
  assert.equal((await runVariant('auth-32', suite)).outcome, 'ALL_PASS')
  const invalid = prepareSuite({ builder: [], code: code.replace('toBe(0)', 'toBe(1)') })
  assert.equal((await runVariant(null, invalid)).outcome, 'ASSERTION_MISMATCH')
  assert.equal((await runVariant(null, suite, 1)).outcome, 'TIMEOUT')
  assert.equal((await runVariant(null, suite, 4500, '0'.repeat(64))).outcome, 'INFRA_FAILURE')
  assert.throws(() => prepareSuite({ builder: [], code: "test('escape',()=>{process.exit()})" }))
})
