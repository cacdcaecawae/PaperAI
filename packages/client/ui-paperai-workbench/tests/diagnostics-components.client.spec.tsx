// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectDoctor } from '../src/client/ProjectDoctor.tsx'
import type { ProjectCheckState } from '../src/client/diagnostics-controller.ts'
import type { PaperAIWorkingRecoveryPlan } from '../src/client/types.ts'
import { zh, type PaperAIWorkbenchKey } from '../src/client/locales.ts'
import { COMMIT_1, DOCUMENT_ID } from './fixtures.client.ts'

afterEach(cleanup)
const translate = (key: PaperAIWorkbenchKey): string => zh[key]
const plan: PaperAIWorkingRecoveryPlan = {
  documentId: DOCUMENT_ID, headCommitId: COMMIT_1, sha256: 'verified-digest', workingPath: 'C:\\paper\\working\\proposal.docx',
}
const report: NonNullable<ProjectCheckState['report']> = {
  documents: 1, checkedAt: '2026-09-05T00:00:00Z', repairs: [plan],
  issues: [{ documentId: DOCUMENT_ID, code: 'missing-working', path: plan.workingPath, detail: 'file does not exist' }],
}

const capture = vi.fn(() => Promise.resolve())

describe('Project Doctor review and recovery', () => {
  it('offers to record a Working DOCX changed outside PaperAI as a version', () => {
    const inspect = vi.fn(() => Promise.resolve())
    const changed = { ...report, repairs: [], issues: [{ documentId: DOCUMENT_ID, code: 'working-changed' as const, path: plan.workingPath, detail: 'bytes differ' }] }
    render(<ProjectDoctor state={{ busy: false, report: changed, error: null }} inspect={inspect} capture={capture} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    expect(screen.getByText(zh['doctor.issue.working-changed'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '记为新版本' }))
    expect(capture).toHaveBeenCalledWith(DOCUMENT_ID)
  })

  it('scans only when opened or explicitly refreshed and preserves cached findings on reopen', () => {
    const inspect = vi.fn(() => Promise.resolve())
    const view = render(<ProjectDoctor state={undefined} inspect={inspect} capture={capture} t={translate} />)
    expect(inspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    expect(inspect).toHaveBeenCalledOnce()
    view.rerender(<ProjectDoctor state={{ busy: true, report: null, error: null }} inspect={inspect} capture={capture} t={translate} />)
    expect(screen.getByRole('button', { name: '正在检查…' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<ProjectDoctor state={{ busy: false, report: { ...report, issues: [], repairs: [] }, error: null }}
      inspect={inspect} capture={capture} t={translate} />)
    expect(screen.getByRole('status').textContent).toBe(zh['doctor.healthy'])
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    expect(inspect).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('requires plan review before recovery, permits dismissal, and sends the exact reviewed head', async () => {
    const inspect = vi.fn(() => Promise.resolve())
    render(<ProjectDoctor state={{ busy: false, report, error: null }} inspect={inspect} capture={capture} t={translate} />)
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
    const view = render(<ProjectDoctor state={{ busy: false, report, error: null }} inspect={inspect} capture={capture} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: '项目体检' }))
    fireEvent.click(screen.getByRole('button', { name: '查看恢复方案 · proposal.docx' }))
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(screen.queryByRole('region', { name: '查看恢复方案' })).toBeNull()
    expect(inspect).toHaveBeenCalledWith()
    view.rerender(<ProjectDoctor state={{ busy: false, report: null, error: 'Inspection unavailable' }} inspect={inspect} capture={capture} t={translate} />)
    expect(screen.getByRole('alert').textContent).toBe('Inspection unavailable')
  })
})
