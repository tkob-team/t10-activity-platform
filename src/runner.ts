import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./worker.ts', import.meta.url))
export type Outcome = 'ALL_PASS' | 'ASSERTION_MISMATCH' | 'SUT_RUNTIME_ERROR' | 'INFRA_FAILURE' | 'TIMEOUT'
export type Evidence = {
  outcome: Outcome, durationMs: number, exitCode: number | null, signal: string | null,
  failure?: { testId: string, stepIndex: number, matcher: string, actual: string, expected: string },
  results?: unknown
}

export function runVariant(variant: string | null, suite: unknown, timeoutMs = 4500, packHash?: string): Promise<Evidence> {
  const start = performance.now()
  const nonce = randomUUID()
  return new Promise(resolve => {
    const child = fork(entry, [], {
      env: { PATH: process.env.PATH, SUT_PACK_FILE: process.env.SUT_PACK_FILE },
      execArgv: ['--max-old-space-size=128'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    })
    let response: any
    let expired = false
    let failed = false
    const timer = setTimeout(() => {
      expired = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('message', (message: any) => {
      if (!response && message?.nonce === nonce &&
          ['ALL_PASS', 'ASSERTION_MISMATCH', 'TIMEOUT', 'SUT_RUNTIME_ERROR', 'INFRA_FAILURE'].includes(message.outcome) &&
          (message.outcome !== 'ASSERTION_MISMATCH' || message.failure?.testId)) response = message
    })
    child.on('error', () => { failed = true; child.kill('SIGKILL') })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      const clean = !failed && !expired && exitCode === 0 && response
      resolve({
        outcome: expired ? 'TIMEOUT' : clean ? response.outcome : 'INFRA_FAILURE',
        durationMs: Math.round(performance.now() - start), exitCode, signal,
        ...(clean && response.failure ? { failure: response.failure } : {}),
        ...(clean && response.results ? { results: response.results } : {})
      })
    })
    child.send({ nonce, variant, suite, packHash }, error => {
      if (error) { failed = true; child.kill('SIGKILL') }
    })
  })
}
