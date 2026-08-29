const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const readline = require('node:readline')

const model = {
  id: 'fake-codex',
  displayName: 'Fake Codex',
  description: 'Deterministic adapter test model.',
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
  inputModalities: ['text'],
}

function nextThreadId() {
  const statePath = process.env.FAKE_CODEX_THREAD_STATE
  if (statePath === undefined) return 'real-codex-adapter-session'
  const previous = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0
  const next = previous + 1
  writeFileSync(statePath, String(next), 'utf8')
  return `real-codex-adapter-session-${next}`
}

function response(method) {
  switch (method) {
    case 'initialize':
      return { codexHome: process.cwd() }
    case 'account/read':
      return { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
    case 'skills/extraRoots/set':
      return {}
    case 'skills/list':
      return { data: [] }
    case 'thread/start':
      return {
        thread: { id: nextThreadId() },
        model: model.id,
        reasoningEffort: 'medium',
        modelProvider: 'openai',
        serviceTier: null,
      }
    case 'model/list':
      return { data: [model], nextCursor: null }
    case 'thread/unsubscribe':
      return {}
    default:
      return {}
  }
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === 'thread/resume' && process.env.FAKE_CODEX_REJECT_RESUME === '1') {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      error: { code: -32603, message: 'Internal error' },
    })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, result: response(request.method) })}\n`)
})
