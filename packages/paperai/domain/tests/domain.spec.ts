import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertMutationAllowed,
  assertProjectInScope,
  assertWriteWithinWorkspace,
  deliveryBlocked,
  DocumentId,
  PaperAccessError,
  ProjectId,
  summarizeGate,
  TemplateContractId,
  type GateReport,
  type PaperAccessScope,
} from '../src/index.ts'

const report = (mode: GateReport['mode'], severity: 'error' | 'warning', overridden = false): GateReport => ({
  status: severity === 'error' && !overridden ? 'fail' : 'pass-with-exceptions',
  mode,
  documentId: DocumentId('doc-1'),
  findings: [{
    id: 'finding-1',
    severity,
    code: 'fixture',
    message: 'fixture',
    overridden,
  }],
  checkedAt: '2026-08-28T00:00:00.000Z',
})

describe('PaperAI domain vocabulary', () => {
  it('brands ids without changing their wire value', () => {
    expect(DocumentId('doc-1')).toBe('doc-1')
  })

  it('blocks only active hard errors in delivery mode', () => {
    expect(deliveryBlocked(report('delivery-export', 'error'))).toBe(true)
    expect(deliveryBlocked(report('draft-export', 'error'))).toBe(false)
    expect(deliveryBlocked(report('delivery-export', 'warning'))).toBe(false)
    expect(deliveryBlocked(report('delivery-export', 'error', true))).toBe(false)
  })
})

describe('access scope', () => {
  const root = process.platform === 'win32' ? 'C:\\papers\\thesis' : '/papers/thesis'
  const scope = (sandboxMode: PaperAccessScope['sandboxMode']): PaperAccessScope => ({
    projectId: ProjectId('project-1'), workspaceRoot: root, sandboxMode,
  })

  it('refuses other projects and read-only mutations with self-describing codes', () => {
    const inScope = (): void => { assertProjectInScope(scope('workspace-write'), ProjectId('project-1'), 'document') }
    const outOfScope = (): void => { assertProjectInScope(scope('workspace-write'), ProjectId('project-2'), "document 'd'") }
    expect(inScope).not.toThrow()
    expect(outOfScope).toThrow(PaperAccessError)
    expect(outOfScope).toThrow(/^PROJECT_OUT_OF_SCOPE: document 'd' belongs to/)
    try {
      outOfScope()
    } catch (error) {
      expect(error).toMatchObject({ name: 'PaperAccessError', code: 'PROJECT_OUT_OF_SCOPE' })
    }
    const mutate = (mode: PaperAccessScope['sandboxMode']) => (): void => { assertMutationAllowed(scope(mode), 'commit') }
    expect(mutate('read-only')).toThrow(/^READ_ONLY_SESSION: commit is refused/)
    expect(mutate('workspace-write')).not.toThrow()
    expect(mutate('danger-full-access')).not.toThrow()
  })

  it('confines written files to the workspace unless the session has full access', () => {
    const inside = join(root, 'exports', 'drafts', 'a.docx')
    expect(assertWriteWithinWorkspace(scope('workspace-write'), inside, 'destination')).toBe(inside)
    expect(assertWriteWithinWorkspace(scope('workspace-write'), root, 'destination')).toBe(root)
    // A relative destination resolves against the workspace, not the process cwd.
    expect(assertWriteWithinWorkspace(scope('workspace-write'), join('exports', 'b.docx'), 'destination'))
      .toBe(join(root, 'exports', 'b.docx'))
    for (const outside of [join(dirname(root), 'other.docx'), join(root, '..', 'x.docx'), `${root}-sibling`]) {
      const confined = (mode: PaperAccessScope['sandboxMode']) => (): string => (
        assertWriteWithinWorkspace(scope(mode), outside, 'destination')
      )
      expect(confined('workspace-write')).toThrow(/^WRITE_OUTSIDE_WORKSPACE: destination/)
      expect(confined('read-only')).toThrow(PaperAccessError)
      expect(confined('danger-full-access')()).toBe(resolve(root, outside))
    }
  })
})

describe('summarizeGate', () => {
  it('counts active findings, ranks errors first, and caps the highlight list', () => {
    const digest = summarizeGate({
      status: 'fail',
      mode: 'continuous',
      documentId: DocumentId('doc-1'),
      templateId: TemplateContractId('contract-1'),
      findings: [
        { id: 'i', severity: 'info', code: 'NOTE', message: 'note' },
        { id: 'w', severity: 'warning', code: 'SPACING', message: 'spacing' },
        { id: 'e1', severity: 'error', code: 'FONT', message: 'font' },
        { id: 'e2', severity: 'error', code: 'SECTION', message: 'section' },
        { id: 'e3', severity: 'error', code: 'FIELD', message: 'field' },
        { id: 'e4', severity: 'error', code: 'PAGE', message: 'page' },
        { id: 'e5', severity: 'error', code: 'REFS', message: 'refs' },
        { id: 'o', severity: 'error', code: 'IGNORED', message: 'ignored', overridden: true },
      ],
      checkedAt: '2026-08-28T00:00:00.000Z',
    })
    expect(digest).toMatchObject({ status: 'fail', errorCount: 5, warningCount: 1, infoCount: 1 })
    expect(digest.topFindings).toHaveLength(5)
    expect(digest.topFindings.every(finding => finding.severity === 'error')).toBe(true)
    expect(digest.topFindings.map(finding => finding.code)).not.toContain('IGNORED')
    expect(digest.nextActions).toBe('修复 5 处 error 级发现后再继续写作，然后用 paperai_check_gate 复核。')
  })

  it('distinguishes warning-only, passing, and templateless reports', () => {
    const base = {
      mode: 'continuous' as const,
      documentId: DocumentId('doc-1'),
      checkedAt: '2026-08-28T00:00:00.000Z',
    }
    const warned = summarizeGate({
      ...base,
      status: 'pass-with-exceptions',
      templateId: TemplateContractId('contract-1'),
      findings: [{ id: 'w', severity: 'warning', code: 'SPACING', message: 'spacing' }],
    })
    expect(warned.nextActions).toBe('无 error 级发现；1 处 warning 建议与用户确认后处理。')
    const passed = summarizeGate({
      ...base,
      status: 'pass',
      templateId: TemplateContractId('contract-1'),
      findings: [],
    })
    expect(passed.nextActions).toBe('门禁通过，可继续写作。')
    const free = summarizeGate({ ...base, status: 'pass', findings: [] })
    expect(free.nextActions).toBe('未关联模板：自由写作模式，无模板检查。')
    const dangling = summarizeGate({
      ...base,
      status: 'fail',
      findings: [{ id: 'm', severity: 'error', code: 'template_missing', message: 'missing' }],
    })
    expect(dangling.nextActions).toBe('修复 1 处 error 级发现后再继续写作，然后用 paperai_check_gate 复核。')
  })
})
