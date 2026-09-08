// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentDiagnostics, type AgentDiagnosticsProps } from '../src/client/AgentDiagnostics.tsx'
import { ProjectDoctor } from '../src/client/ProjectDoctor.tsx'
import type { DiagnosticsState, ProjectCheckState } from '../src/client/diagnostics-controller.ts'
import type { PaperAIAgentDiagnostic, PaperAIWorkingRecoveryPlan } from '../src/client/types.ts'
import { zh, type PaperAIWorkbenchKey } from '../src/client/locales.ts'
import { COMMIT_1, DOCUMENT_ID } from './fixtures.client.ts'

afterEach(cleanup)
const translate = (key: PaperAIWorkbenchKey): string => zh[key]
const discovered: PaperAIAgentDiagnostic = {
  provider: 'claude', executable: '/adapter', adapterVersion: null, agentVersion: null,
  status: 'discovered', models: [], checkedAt: null, retryAt: null, elapsedMs: null, error: null,
}

function agentProps(agents: readonly PaperAIAgentDiagnostic[] = []): AgentDiagnosticsProps {
  const state = createSnapshotStore<DiagnosticsState>({ agents, probing: [], agentError: null, projects: {} })
  const useDiagnostics: SnapshotSelectorHook<DiagnosticsState> = selector =>
    selector(useSyncExternalStore(listener => state.subscribe(listener), () => state.getSnapshot()))
  return {
    presetId: 'claude', connecting: false, useDiagnostics,
    loadAgents: vi.fn(() => Promise.resolve()), probe: vi.fn(() => Promise.resolve()),
    t: key => (zh as Record<string, string>)[key] ?? key,
  } as AgentDiagnosticsProps
}

describe('Agent diagnostics interactions', () => {
  it('keeps metadata behind a disclosure and requests a probe only on an explicit action', () => {
    const props = agentProps([discovered])
    render(<AgentDiagnostics {...props} />)
    expect(props.loadAgents).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Agent 状态' }))
    expect(screen.getByText(zh['agent.discovered'])).toBeTruthy()
    expect(screen.getByText(/— · —/u)).toBeTruthy()
    expect(props.probe).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '检测 / 重试' }))
    expect(props.probe).toHaveBeenCalledWith('claude', true)
    fireEvent.click(screen.getByRole('button', { name: 'Agent 状态' }))
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('shows historical models without offering them as live choices and blocks probing while connecting', () => {
    const props = agentProps([{ ...discovered, provider: 'codex', status: 'ready',
      adapterVersion: '1.2', agentVersion: '2.3', checkedAt: 1,
      models: [{ id: 'historic', name: 'Earlier model' }] }])
    const view = render(<AgentDiagnostics {...props} presetId="codex" />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent 状态' }))
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('Earlier model')).toBeTruthy()
    expect(screen.getByText(zh['agent.cachedModels'])).toBeTruthy()
    expect(screen.queryByRole('menuitem')).toBeNull()
    view.rerender(<AgentDiagnostics {...props} presetId="codex" connecting />)
    expect(screen.getByRole('button', { name: '检测 / 重试' }).hasAttribute('disabled')).toBe(true)
    expect(props.loadAgents).toHaveBeenCalledTimes(2)
  })

  it('reports authentication and cooldown separately from a failed metadata request', () => {
    const props = agentProps()
    props.useDiagnostics = selector => selector({
      agents: [{ ...discovered, status: 'error', error: 'authentication', retryAt: 1000 }],
      probing: ['claude'], agentError: 'Could not refresh status', projects: {},
    })
    render(<AgentDiagnostics {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent 状态' }))
    expect(screen.getAllByRole('alert').map(node => node.textContent))
      .toEqual([zh['agent.error.authentication'], 'Could not refresh status'])
    expect(screen.getByText(/自动检测冷却至/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '正在检测…' }).hasAttribute('disabled')).toBe(true)
  })

  it('allows discovery before metadata arrives and omits the surface for other Agent engines', () => {
    const props = agentProps()
    const view = render(<AgentDiagnostics {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent 状态' }))
    expect(screen.getByRole('button', { name: '检测 / 重试' }).hasAttribute('disabled')).toBe(false)
    view.rerender(<AgentDiagnostics {...props} presetId="dsh" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

const plan: PaperAIWorkingRecoveryPlan = {
  documentId: DOCUMENT_ID, headCommitId: COMMIT_1, sha256: 'verified-digest', workingPath: 'C:\\paper\\working\\proposal.docx',
}
const report: NonNullable<ProjectCheckState['report']> = {
  documents: 1, checkedAt: '2026-09-05T00:00:00Z', repairs: [plan],
  issues: [{ documentId: DOCUMENT_ID, code: 'missing-working', path: plan.workingPath, detail: 'file does not exist' }],
}

describe('Project Doctor review and recovery', () => {
  it('scans only when opened or explicitly refreshed and preserves cached findings on reopen', () => {
    const inspect = vi.fn(() => Promise.resolve())
    const view = render(<ProjectDoctor state={undefined} inspect={inspect} t={translate} />)
    expect(inspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    expect(inspect).toHaveBeenCalledOnce()
    view.rerender(<ProjectDoctor state={{ busy: true, report: null, error: null }} inspect={inspect} t={translate} />)
    expect(screen.getByRole('button', { name: '正在检查…' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<ProjectDoctor state={{ busy: false, report: { ...report, issues: [], repairs: [] }, error: null }}
      inspect={inspect} t={translate} />)
    expect(screen.getByRole('status').textContent).toBe(zh['doctor.healthy'])
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    expect(inspect).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('requires plan review before recovery, permits dismissal, and sends the exact reviewed head', async () => {
    const inspect = vi.fn(() => Promise.resolve())
    render(<ProjectDoctor state={{ busy: false, report, error: null }} inspect={inspect} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    expect(screen.getByText('C:/paper/working/proposal.docx')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复缺失文件' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看恢复方案 · proposal.docx' }))
    expect(inspect).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: '查看恢复方案' }).textContent).toContain(COMMIT_1)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('region', { name: '查看恢复方案' })).toBeNull()
    expect(inspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看恢复方案 · proposal.docx' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复缺失文件' }))
    expect(inspect).toHaveBeenCalledWith(plan)
    await waitFor(() => { expect(screen.queryByRole('region', { name: '查看恢复方案' })).toBeNull() })
  })

  it('clears the reviewed plan before a new scan and exposes a failed inspection', () => {
    const inspect = vi.fn(() => Promise.resolve())
    const view = render(<ProjectDoctor state={{ busy: false, report, error: null }} inspect={inspect} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    fireEvent.click(screen.getByRole('button', { name: '查看恢复方案 · proposal.docx' }))
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(screen.queryByRole('region', { name: '查看恢复方案' })).toBeNull()
    expect(inspect).toHaveBeenCalledWith()
    view.rerender(<ProjectDoctor state={{ busy: false, report: null, error: 'Inspection unavailable' }} inspect={inspect} t={translate} />)
    expect(screen.getByRole('alert').textContent).toBe('Inspection unavailable')
  })
})
