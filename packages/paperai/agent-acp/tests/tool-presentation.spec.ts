import { expect, it } from 'vitest'
import { ACP_TOOL, PAPERAI_TOOL, presentAcpCall, presentAcpResult, presentationName, type AcpToolDisplay } from '../src/tool-presentation.ts'
import { environmentSecrets, redactAcpText } from '../src/redaction.ts'

const call: AcpToolDisplay = { name: 'research', title: 'Research paper', kind: 'search', status: 'in_progress',
  input: { query: 'paper' }, output: '', truncated: false, diffs: [], locations: [{ path: '/paper', line: 2 }, { path: '/notes' }] }

it('renders durable generic progress, terminal output and file diffs without consulting the provider', () => {
  expect(presentAcpCall(call)).toEqual({ card: 'generic', title: 'Research paper', rawInput: { query: 'paper' },
    content: [], locations: call.locations })
  const completed = { ...call, status: 'completed', output: 'Evidence', truncated: true }
  expect(presentAcpCall(completed)).toMatchObject({ content: [{ type: 'text', text: 'Evidence\n[输出已截断]' }] })
  expect(presentAcpResult(completed)).toMatchObject({ card: 'generic', content: [{ type: 'text', text: 'Evidence\n[输出已截断]' }] })
  expect(presentAcpResult({ ...completed, kind: 'execute', truncated: false }))
    .toEqual({ card: 'terminal', title: 'Research paper', output: 'Evidence' })
  const changed = { ...call, diffs: [{ path: '/paper', oldText: 'before', newText: 'after' }] }
  expect(presentAcpCall(changed)).toEqual({ card: 'diff', title: call.title, diffs: changed.diffs, locations: call.locations })
  expect(presentAcpResult(changed)).toEqual({ card: 'diff', title: call.title, diffs: changed.diffs })
})

it('redacts overlapping known credentials and authorization fragments while preserving ordinary launch values', () => {
  expect(environmentSecrets({ API_KEY: 'key-one', ACCESS_TOKEN: 'token', LANG: 'zh', PATH: '/bin' }))
    .toEqual(['key-one', 'token'])
  expect(environmentSecrets(undefined)).toEqual([])
  expect(redactAcpText('key-one-long key-one Authorization: Bearer unknown https://user:pass@api.test?token=other&x=1',
    ['key-one', 'key-one-long', '', 'key-one']))
    .toBe('[redacted] [redacted] Authorization: [redacted] https://[redacted]@api.test?token=[redacted]&x=1')
})

it('gives the PaperAI MCP tools their own transcript name and leaves every other provider tool on the shared one', () => {
  expect(presentationName({ name: 'mcp__paperai__paperai_commit_document', title: 'paperai: paperai_commit_document' })).toBe(PAPERAI_TOOL)
  expect(presentationName({ name: 'read', title: 'mcp.paperai.paperai_read_document' })).toBe(PAPERAI_TOOL)
  expect(presentationName({ name: 'paperai_check_gate', title: 'Check' })).toBe(PAPERAI_TOOL)
  expect(presentationName({ name: 'paperai.edit', title: 'Edit introduction' })).toBe(ACP_TOOL)
  expect(presentationName({ name: 'terminal', title: 'Streaming output' })).toBe(ACP_TOOL)
  expect(presentationName({ name: 'mcp__notpaperai_read_document', title: '' })).toBe(ACP_TOOL)
})
