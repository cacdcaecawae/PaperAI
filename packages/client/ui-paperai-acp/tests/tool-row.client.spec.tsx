// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PAPERAI_TOOL as HOST_NAME } from '@paperai/agent-acp/src/tool-presentation.ts'
import { AcpToolRow, PAPERAI_TOOL, type AcpToolRowProps } from '../src/client/AcpToolRow.tsx'
import { t } from './translations.client.ts'

afterEach(cleanup)

const display = {
  name: 'mcp__paperai__paperai_commit_document', title: 'paperai: paperai_commit_document', kind: 'other', status: 'in_progress',
  input: { documentId: 'public-synthetic-document', expectedRevision: 1 }, output: '', truncated: false, diffs: [], locations: [],
}
const running = {
  callId: 'call-1', name: PAPERAI_TOOL, argsRaw: JSON.stringify(display), turn: 1, step: 1, time: 10, callView: null, subCalls: [],
}
// The Host records the provider's whole MCP result envelope as the text part of the settled call.
const envelope = JSON.stringify({
  content: [{ type: 'text', text: '{"error":"revision_conflict","detail":"Read the current revision before retrying."}' }],
  isError: true,
})
const failed = {
  kind: 'tool-result', seq: 2, time: 20, callId: 'call-1', call: { name: PAPERAI_TOOL, argsRaw: JSON.stringify(display) }, callTime: 10,
  content: [{ type: 'text', text: envelope }],
  isError: true, callView: null, resultView: null, subCalls: [],
}

function props(block: unknown, inspect = vi.fn()): AcpToolRowProps {
  return { callId: 'call-1', toolName: PAPERAI_TOOL, block, openFile: vi.fn(), inspect, t } as unknown as AcpToolRowProps
}

it('keys on the same transcript name the Host writes for PaperAI tool calls', () => {
  expect(PAPERAI_TOOL).toBe(HOST_NAME)
})

it('names the running call in words with a state dot and no provider title, and opens to the input', () => {
  const view = render(<AcpToolRow {...props(running)} />)
  const card = view.container.firstElementChild as HTMLElement
  expect(card.dataset.tool).toBe(PAPERAI_TOOL)
  expect(card.dataset.state).toBe('running')
  const row = screen.getByRole('button', { name: /提交修改/ })
  expect(row.textContent).toBe('提交修改')
  expect(row.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(/public-synthetic-document/)).toBeNull()
  fireEvent.click(row)
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('输入')).toBeTruthy()
  expect(screen.getByText(/"documentId": "public-synthetic-document"/)).toBeTruthy()
  expect(screen.queryByText('输出')).toBeNull()
})

it('remembers a failed call by its detail line and shows the full output and inspect action once opened', () => {
  const inspect = vi.fn()
  const view = render(<AcpToolRow {...props(failed, inspect)} />)
  const card = view.container.firstElementChild as HTMLElement
  expect(card.dataset.state).toBe('error')
  expect(card.firstElementChild?.textContent).toBe('失败')
  const row = screen.getByRole('button', { name: /提交修改/ })
  expect(row.textContent).toBe('提交修改Read the current revision before retrying.')
  expect(row.textContent).not.toContain('revision_conflict')
  expect(row.textContent).not.toContain('"content"')
  fireEvent.click(row)
  expect(screen.getByText('输出')).toBeTruthy()
  // The envelope is unwrapped: people read what the tool wrote, not the transport around it.
  expect(screen.getByText(/"error":"revision_conflict"/).textContent).not.toContain('"isError"')
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  expect(inspect).toHaveBeenCalledTimes(1)
})

it('falls back to the provider words for a tool it does not know and to a plain result line for a text failure', () => {
  const unknown = {
    ...failed,
    call: { name: PAPERAI_TOOL, argsRaw: JSON.stringify({ ...display, name: 'paperai_future_tool', title: 'PaperAI future', input: undefined }) },
    content: [{ type: 'text', text: 'first line\nsecond line' }],
  }
  render(<AcpToolRow {...props(unknown)} />)
  const row = screen.getByRole('button', { name: /paperai_future_tool/ })
  expect(row.textContent).toBe('paperai_future_toolfirst line')
  cleanup()
  const done = { ...failed, isError: false, content: [{ type: 'text', text: 'ok' }], call: { name: PAPERAI_TOOL, argsRaw: 'not json' } }
  const view = render(<AcpToolRow {...props(done)} />)
  expect((view.container.firstElementChild as HTMLElement).dataset.state).toBe('ok')
  const bare = view.container.querySelector('[data-disclosure-row]')!
  expect(bare.textContent).toBe('')
  fireEvent.click(bare)
  expect(screen.getByText('ok')).toBeTruthy()
})
