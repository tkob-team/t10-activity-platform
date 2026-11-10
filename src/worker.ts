import { isDeepStrictEqual } from 'node:util'
import { fixtureRuntime } from './eshop-runtime.mjs'
import { readResult, resolveValue } from './submission.mjs'
import { loadPack } from './pack.ts'
import type { Evidence, Outcome } from './runner.ts'

const clip = (value: unknown) => (JSON.stringify(value) ?? '(không có)').slice(0, 360)

function matches(matcher: string, actual: unknown, expected: unknown) {
  if (matcher === 'toBe') return Object.is(actual, expected)
  if (matcher === 'toEqual') return isDeepStrictEqual(actual, expected)
  if (matcher === 'toContain') return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
  if (typeof actual !== 'number' || typeof expected !== 'number') return false
  return matcher === 'toBeGreaterThan' ? actual > expected : actual < expected
}

async function evaluate(pack: ReturnType<typeof loadPack>, variant: string | null, suite: any[]) {
  const source = variant ? pack.variants[variant]?.source : pack.baseline.source
  if (!source) throw new Error('Unknown variant')
  const results: any[] = []
  let failure: Evidence['failure']
  let error: Outcome | undefined
  for (const test of suite) {
    const row = { id: test.id, name: test.name, outcome: 'ALL_PASS' as Outcome, steps: [] as unknown[] }
    const values = new Map()
    let runtime
    try {
      runtime = await fixtureRuntime(source, pack.baseline.database, pack, test.scenario)
      for (const [index, step] of test.steps.entries()) {
        if (step.kind === 'call') {
          const output = await runtime.call(step.op, step.args.map(value => resolveValue(values, value)))
          values.set(step.as, output)
          if (!variant) row.steps.push({ index, operation: step.op, status: output.status, body: clip(output.body) })
        } else {
          const actual = readResult(values, step.actual)
          const expected = resolveValue(values, step.expected)
          if (expected === undefined) throw new Error('Expected reference has no value')
          const pass = matches(step.matcher, actual, expected)
          if (!variant) row.steps.push({ index, pass, matcher: step.matcher, actual: clip(actual), expected: clip(expected) })
          if (!pass) {
            row.outcome = 'ASSERTION_MISMATCH'
            failure ??= { testId: test.id, stepIndex: index, matcher: step.matcher, actual: clip(actual), expected: clip(expected) }
            break
          }
        }
      }
    } catch (cause: any) {
      row.outcome = cause.name === 'TimeoutError' ? 'TIMEOUT' : 'SUT_RUNTIME_ERROR'
      error ??= row.outcome
    } finally {
      if (runtime) {
        try { await runtime.close() } catch { row.outcome = 'SUT_RUNTIME_ERROR'; error ??= row.outcome }
      }
    }
    if (!variant) results.push(row)
    if (variant && (error || failure)) break
  }
  return { outcome: error ?? (failure ? 'ASSERTION_MISMATCH' : 'ALL_PASS'), failure, ...(!variant ? { results } : {}) }
}

process.once('message', async ({ nonce, variant, suite, packHash }: any) => {
  let result
  try {
    const pack = loadPack()
    result = packHash && packHash !== pack.id ? { outcome: 'INFRA_FAILURE' } : await evaluate(pack, variant, suite)
  } catch { result = { outcome: 'INFRA_FAILURE' } }
  process.send?.({ nonce, ...result }, error => {
    if (error) process.exitCode = 1
    process.disconnect?.()
  })
})
