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
        thread: { id: 'real-codex-adapter-session' },
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
  process.stdout.write(`${JSON.stringify({ id: request.id, result: response(request.method) })}\n`)
})
