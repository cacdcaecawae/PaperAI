// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { DocumentWorkbench } from '../src/client/DocumentWorkbench.tsx'
import { WorkspaceContent } from '../src/client/WorkspaceContent.tsx'
import { zh } from '../src/client/locales.ts'
import type {
  PaperAIDocumentWorkbenchProps, PaperAIWorkspaceContentProps,
} from '../src/client/slots.ts'
import type {
  PaperAIResourceDirectoryState, PaperAIResourceTreeState, PaperAIWorkbenchState,
} from '../src/client/types.ts'
import {
  COMMIT_0, CONFIRMED_TEMPLATE_CATALOG, documentSnapshot, HIT_PACK_ID,
  HIT_PROPOSAL_MEMBER_ID, HIT_TEMPLATE_ID, NODE_PARAGRAPH, RESOURCES,
  RESOURCE_ID, SESSION_ID, TEMPLATE_CATALOG, textNodeBuffer, WORKSPACE_ID,
  REVISION_2,
} from './fixtures.client.ts'

afterEach(cleanup)

function bind<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  return function useSelector<S>(selector: (state: T) => S): S {
    const value = useSyncExternalStore(
      listener => source.subscribe(listener),
      () => source.getSnapshot(),
      () => source.getSnapshot(),
    )
    return selector(value)
  }
}

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}) as PaperAIDocumentWorkbenchProps['t']

function workspaceProps(state: PaperAIResourceTreeState) {
  const store = createSnapshotStore<PaperAIResourceDirectoryState>({
    workspaces: { [WORKSPACE_ID]: state },
  })
  const ensureResources = vi.fn(async () => {})
  const refreshResources = vi.fn(async () => {})
  const openResource = vi.fn(async () => {})
  const importDocument = vi.fn<PaperAIWorkspaceContentProps['importDocument']>()
    .mockResolvedValue({ ok: true })
  const props = {
    workspaceId: WORKSPACE_ID,
    path: 'F:/paper',
    title: 'Paper',
    active: true,
    useResources: bind(store),
    ensureResources,
    refreshResources,
    openResource,
    importDocument,
    t,
  } as unknown as PaperAIWorkspaceContentProps
  return { props, store, ensureResources, refreshResources, openResource, importDocument }
}

function workbenchProps(state: PaperAIWorkbenchState) {
  const store = createSnapshotStore(state)
  const closeDetails = vi.fn()
  const selectTab = vi.fn()
  const retryOpen = vi.fn(async () => {})
  const selectNode = vi.fn(async () => ({ ok: true as const }))
  const updateDraft = vi.fn()
  const discardDraft = vi.fn()
  const commitSelected = vi.fn(async () => ({ ok: true as const }))
  const validate = vi.fn(async () => ({ ok: true as const }))
  const loadTemplates = vi.fn(async () => ({ ok: true as const }))
  const installTemplate = vi.fn(async () => ({ ok: true as const }))
  const uploadTemplate = vi.fn<PaperAIDocumentWorkbenchProps['uploadTemplate']>()
    .mockResolvedValue({ ok: true })
  const confirmTemplate = vi.fn(async () => ({ ok: true as const }))
  const associateTemplate = vi.fn(async () => ({ ok: true as const }))
  const exportDocument = vi.fn(async () => ({ ok: true as const }))
  const reloadExternal = vi.fn(async () => ({ ok: true as const }))
  const resolveExternalConflict = vi.fn()
  const restore = vi.fn(async () => ({ ok: true as const }))
  const props = {
    sessionId: SESSION_ID,
    closeDetails,
    useWorkbench: bind(store),
    selectTab,
    retryOpen,
    selectNode,
    updateDraft,
    discardDraft,
    commitSelected,
    validate,
    loadTemplates,
    installTemplate,
    uploadTemplate,
    confirmTemplate,
    associateTemplate,
    exportDocument,
    reloadExternal,
    resolveExternalConflict,
    restore,
    t,
  } as unknown as PaperAIDocumentWorkbenchProps
  return {
    props, store, closeDetails, selectTab, retryOpen, selectNode, updateDraft,
    discardDraft, commitSelected, validate, loadTemplates, installTemplate,
    uploadTemplate, confirmTemplate, associateTemplate, exportDocument,
    reloadExternal, resolveExternalConflict, restore,
  }
}

function workbenchState(overrides: Partial<PaperAIWorkbenchState>): PaperAIWorkbenchState {
  return {
    phase: 'idle',
    tab: 'preview',
    document: null,
    nodePhase: 'idle',
    selectedNode: null,
    draft: '',
    dirty: false,
    action: null,
    templates: null,
    exportReceipt: null,
    externalUpdate: null,
    externalConflict: null,
    error: null,
    nodeError: null,
    actionError: null,
    ...overrides,
  }
}

describe('WorkspaceContent', () => {
  it('renders only Host-backed groups and makes only openable rows interactive', async () => {
    const b = workspaceProps({
      phase: 'ready', resources: RESOURCES.resources, selected: null, error: null,
    })
    render(<WorkspaceContent {...b.props} />)

    await waitFor(() => { expect(b.ensureResources).toHaveBeenCalledWith(WORKSPACE_ID) })
    for (const label of ['文档', '模板', '代码']) {
      expect(screen.getByRole('region', { name: label })).not.toBeNull()
    }
    expect(screen.queryByRole('region', { name: '图像' })).toBeNull()
    expect(screen.queryByRole('region', { name: '实验' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开 thesis.docx' }))
    expect(b.openResource).toHaveBeenCalledWith(WORKSPACE_ID, RESOURCE_ID)
    expect(screen.queryByRole('button', { name: /HIT master/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /analysis.py/ })).toBeNull()
  })

  it('shows a backed retry for resource failures', () => {
    const failed = workspaceProps({
      phase: 'error', resources: [], selected: null, error: 'Host offline',
    })
    const view = render(<WorkspaceContent {...failed.props} />)
    expect(screen.getByRole('alert').textContent).toContain('暂时无法读取项目内容。')
    expect(screen.getByRole('alert').textContent).not.toContain('Host offline')
    expect(screen.getByRole('button', { name: '导入 Word' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(failed.refreshResources).toHaveBeenCalledWith(WORKSPACE_ID)
    view.unmount()
  })

  it('renders one project-level empty state without fictional categories', () => {
    const empty = workspaceProps({
      phase: 'ready', resources: [], selected: null, error: null,
    })
    render(<WorkspaceContent {...empty.props} />)
    expect(screen.getByRole('heading', { name: '项目内容', level: 3 })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('暂无项目内容')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('renders cold, loading, inline-error, selected, and server snapshots', () => {
    const cold = workspaceProps({
      phase: 'cold', resources: [], selected: null, error: null,
    })
    const view = render(<WorkspaceContent {...cold.props} />)
    expect(screen.getByText('正在读取项目内容…')).not.toBeNull()
    view.unmount()

    const loading = workspaceProps({
      phase: 'loading', resources: [], selected: null, error: null,
    })
    render(<WorkspaceContent {...loading.props} />)
    expect(screen.getByText('正在读取项目内容…')).not.toBeNull()
    cleanup()

    const resources = [
      ...RESOURCES.resources,
      {
        id: 'template-file' as typeof RESOURCE_ID,
        category: 'template' as const,
        kind: 'file' as const,
        name: 'proposal-template.docx',
        path: 'templates/proposal-template.docx',
        depth: 12,
        openable: false,
        status: 'clean' as const,
      },
      {
        id: 'pending-file' as typeof RESOURCE_ID,
        category: 'image' as const,
        kind: 'file' as const,
        name: 'figure.png',
        path: 'images/figure.png',
        depth: -2,
        openable: false,
        status: 'pending' as const,
      },
      {
        id: 'blocked-file' as typeof RESOURCE_ID,
        category: 'experiment' as const,
        kind: 'file' as const,
        name: 'results.csv',
        path: 'experiments/results.csv',
        depth: 0,
        openable: false,
        status: 'blocked' as const,
      },
    ]
    const inline = workspaceProps({
      phase: 'error', resources, selected: RESOURCE_ID, error: null,
    })
    const rendered = render(<WorkspaceContent {...inline.props} />)
    expect(screen.getByText('暂时无法读取项目内容。')).not.toBeNull()
    expect(screen.getByRole('button', { name: '打开 thesis.docx' }).dataset.selected).toBe('true')
    expect(screen.getByText('proposal-template.docx')).not.toBeNull()
    const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: '导入 Word' }))
    expect(click).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files: [] } })
    rendered.unmount()

  })

  it('imports the selected Word file with the chosen academic role', async () => {
    const b = workspaceProps({
      phase: 'ready', resources: RESOURCES.resources, selected: null, error: null,
    })
    const view = render(<WorkspaceContent {...b.props} />)
    const role = screen.getByRole('button', { name: '文档类型，当前：论文正文' })
    expect(role.getAttribute('aria-haspopup')).toBe('menu')
    expect(role.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(role)
    expect(role.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: '开题报告' }))
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    expect(input?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.change(input!, {
      target: { files: [new File(['word'], 'proposal.docx', { type: 'application/zip' })] },
    })

    await waitFor(() => {
      expect(b.importDocument).toHaveBeenCalledWith(WORKSPACE_ID, {
        fileName: 'proposal.docx',
        contentBase64: 'd29yZA==',
        role: 'proposal',
      })
    })
    expect(screen.queryByText('正在导入…')).toBeNull()
  })

  it('localizes a Host import failure without exposing its internal diagnostic', async () => {
    const b = workspaceProps({
      phase: 'ready', resources: RESOURCES.resources, selected: null, error: null,
    })
    b.importDocument.mockResolvedValueOnce({
      ok: false,
      error: 'legacy-doc-normalization: Microsoft Word is unavailable',
    })
    const view = render(<WorkspaceContent {...b.props} />)
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.change(input!, {
      target: { files: [new File(['legacy'], 'legacy.doc', { type: 'application/msword' })] },
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('未能导入 Word 文档，请确认文件可用后重试。')
    expect(alert.textContent).not.toContain('legacy-doc-normalization')
  })

  it('rejects an invalid browser file and shows the pending import state', async () => {
    const invalid = workspaceProps({
      phase: 'ready', resources: RESOURCES.resources, selected: null, error: null,
    })
    const invalidView = render(<WorkspaceContent {...invalid.props} />)
    fireEvent.change(invalidView.container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect((await screen.findByRole('alert')).textContent)
      .toContain('请选择不超过 32 MB 的 .doc 或 .docx 文件。')
    expect(invalid.importDocument).not.toHaveBeenCalled()
    invalidView.unmount()

    let finish!: (value: { readonly ok: true }) => void
    const pending = workspaceProps({
      phase: 'ready', resources: RESOURCES.resources, selected: null, error: null,
    })
    pending.importDocument.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pendingView = render(<WorkspaceContent {...pending.props} />)
    fireEvent.change(pendingView.container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['word'], 'proposal.docx', { type: 'application/zip' })] },
    })
    expect(await screen.findByText('正在导入…')).not.toBeNull()
    expect(screen.getByRole('button', { name: '文档类型，当前：论文正文' }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => { expect(pending.importDocument).toHaveBeenCalledOnce() })
    finish({ ok: true })
    await waitFor(() => { expect(screen.queryByText('正在导入…')).toBeNull() })
  })
})

describe('DocumentWorkbench', () => {
  it('renders in a blank current Session and closes through the generic host owner', () => {
    const b = workbenchProps(workbenchState({}))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('从左侧项目树选择一个可打开的文档。')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭文档工作台' }))
    expect(b.closeDetails).toHaveBeenCalledOnce()
  })

  it('uses a strict preview sandbox and delegates tab selection', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready', document: documentSnapshot(), nodePhase: 'ready', selectedNode: textNodeBuffer(),
      draft: 'Editable thesis',
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByTitle('文档预览').getAttribute('sandbox')).toBe('')
    expect(screen.queryByText('Codex / gpt-5.6')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '编辑' }))
    expect(b.selectTab).toHaveBeenCalledWith('edit')
  })

  it('offers a conflict-aware external reload while preserving a dirty draft', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      document: documentSnapshot(),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(),
      draft: 'Local changes',
      dirty: true,
      externalUpdate: {
        documentId: documentSnapshot().documentId,
        headCommitId: COMMIT_0,
        updatedAt: '2026-08-28T12:00:00.000Z',
      },
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('其他会话或 Agent 已提交修改。加载时会保留本地草稿；若同一节点也被修改，将提示冲突。')).not.toBeNull()
    const reload = screen.getByRole('button', { name: '查看并解决' })
    expect(reload.hasAttribute('disabled')).toBe(false)
    fireEvent.click(reload)
    expect(b.reloadExternal).toHaveBeenCalledOnce()
  })

  it('shows both same-node conflict inputs and offers local, external, and merged resolutions', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'edit',
      document: documentSnapshot(REVISION_2),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(REVISION_2, 'External rewrite'),
      draft: 'Unsaved local draft',
      dirty: true,
      externalConflict: {
        localDraft: 'Unsaved local draft',
        externalText: 'External rewrite',
      },
    }))
    render(<DocumentWorkbench {...b.props} />)

    expect(document.activeElement).toBe(screen.getByText('当前节点也有外部修改'))
    expect(screen.getByRole('textbox', { name: '本地草稿' }))
      .toHaveProperty('value', 'Unsaved local draft')
    expect(screen.getByRole('textbox', { name: '外部最新文本' }))
      .toHaveProperty('value', 'External rewrite')
    expect(screen.getByText('请先解决当前节点的外部修改冲突。')).not.toBeNull()
    expect(screen.queryByText('请先提交或放弃当前节点的临时修改。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '采用本地版本' }))
    fireEvent.click(screen.getByRole('button', { name: '采用外部版本' }))
    fireEvent.click(screen.getByRole('button', { name: '使用合并内容' }))
    expect(b.resolveExternalConflict.mock.calls).toEqual([['local'], ['external'], ['merged']])
    expect(screen.getByRole('button', { name: '提交并创建版本' }).hasAttribute('disabled')).toBe(true)
  })

  it('returns focus to the editor after conflict resolution removes its action buttons', () => {
    const conflictState = workbenchState({
      phase: 'ready',
      tab: 'edit',
      document: documentSnapshot(REVISION_2),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(REVISION_2, 'External rewrite'),
      draft: 'Merged draft',
      dirty: true,
      externalConflict: {
        localDraft: 'Unsaved local draft',
        externalText: 'External rewrite',
      },
    })
    const b = workbenchProps(conflictState)
    render(<DocumentWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: '使用合并内容' }))
    act(() => { b.store.set({
      ...conflictState,
      externalConflict: null,
    }) })

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '编辑节点：Introduction' }))
  })

  it('keeps navigation, history, template, gate, and export actions locked until a clean-looking conflict is resolved', () => {
    const conflict = {
      phase: 'ready' as const,
      document: documentSnapshot(REVISION_2),
      nodePhase: 'ready' as const,
      selectedNode: textNodeBuffer(REVISION_2, 'External rewrite'),
      draft: 'External rewrite',
      dirty: false,
      externalConflict: {
        localDraft: 'Unsaved local draft',
        externalText: 'External rewrite',
      },
    }
    const edit = workbenchProps(workbenchState({ ...conflict, tab: 'edit' }))
    const view = render(<DocumentWorkbench {...edit.props} />)
    const otherNode = screen.getByRole('button', { name: /Research background/ })
    expect(otherNode.hasAttribute('disabled')).toBe(true)
    expect(otherNode.getAttribute('title')).toBe('请先解决当前节点的外部修改冲突。')

    view.unmount()
    const versions = workbenchProps(workbenchState({ ...conflict, tab: 'versions' }))
    render(<DocumentWorkbench {...versions.props} />)
    expect(screen.getByText('请先解决当前节点的外部修改冲突。')).not.toBeNull()
    expect(screen.getByRole('button', { name: '恢复此版本' }).hasAttribute('disabled')).toBe(true)

    cleanup()
    const gate = workbenchProps(workbenchState({
      ...conflict,
      tab: 'gate',
      templates: { ...TEMPLATE_CATALOG, contracts: [] },
    }))
    render(<DocumentWorkbench {...gate.props} />)
    expect(screen.getByText('请先解决当前节点的外部修改冲突。')).not.toBeNull()
    expect(screen.getByRole('button', { name: '运行门禁' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '安装并解析' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '上传模板' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '导出草稿' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '导出正式版' }).hasAttribute('disabled')).toBe(true)
  })

  it('renders Agent/model provenance and only backed version restore actions', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready', tab: 'versions', document: documentSnapshot(),
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('Codex / gpt-5.6')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '恢复此版本' }))
    expect(b.restore).toHaveBeenCalledWith(COMMIT_0)
  })

  it('explains and disables version restore while a node draft is dirty', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'versions',
      document: documentSnapshot(),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(),
      draft: 'Changed',
      dirty: true,
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('请先提交或放弃当前节点的临时修改，再恢复历史版本。')).not.toBeNull()
    expect(screen.getByRole('button', { name: '恢复此版本' }).hasAttribute('disabled')).toBe(true)
  })

  it('edits one text-node buffer and commits without sending a whole document', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'edit',
      document: documentSnapshot(),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(),
      draft: 'Rewritten introduction',
      dirty: true,
    }))
    render(<DocumentWorkbench {...b.props} />)
    const editor = screen.getByRole('textbox', { name: '编辑节点：Introduction' })
    fireEvent.change(editor, { target: { value: 'Another introduction' } })
    expect(b.updateDraft).toHaveBeenCalledWith('Another introduction')
    fireEvent.click(screen.getByRole('button', { name: '提交并创建版本' }))
    expect(b.commitSelected).toHaveBeenCalledWith()
    expect(screen.queryByTitle('文档预览')).toBeNull()
  })

  it('loads nodes through real controls and locks navigation while the buffer is dirty', () => {
    const clean = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'edit',
      document: documentSnapshot(),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(),
      draft: 'Editable thesis',
    }))
    const view = render(<DocumentWorkbench {...clean.props} />)
    fireEvent.click(screen.getByRole('button', { name: /Research background/ }))
    expect(clean.selectNode).toHaveBeenCalledWith(NODE_PARAGRAPH)

    view.unmount()
    const dirty = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'edit',
      document: documentSnapshot(),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(),
      draft: 'Changed',
      dirty: true,
    }))
    render(<DocumentWorkbench {...dirty.props} />)
    const other = screen.getByRole('button', { name: /Research background/ })
    expect(other.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: /Experiment results/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(dirty.discardDraft).toHaveBeenCalledWith()
  })

  it('runs a real template gate action and renders line-level findings', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready', tab: 'gate', document: documentSnapshot(),
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('Heading font')).not.toBeNull()
    expect(screen.getByText('位置：Chapter 1')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '运行门禁' }))
    expect(b.validate).toHaveBeenCalledOnce()
  })

  it('installs a compatible built-in template and uploads a custom Word template', async () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'gate',
      document: documentSnapshot(),
      templates: { ...TEMPLATE_CATALOG, contracts: [] },
    }))
    const view = render(<DocumentWorkbench {...b.props} />)

    expect(screen.getByText('为开题报告选择模板，审阅解析出的要求后再确认。')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装并解析' }))
    expect(b.installTemplate).toHaveBeenCalledWith(HIT_PACK_ID, HIT_PROPOSAL_MEMBER_ID)

    const usage = screen.getByRole('button', { name: '模板用途，当前：内容表单模板' })
    expect(usage.getAttribute('aria-haspopup')).toBe('menu')
    expect(usage.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(usage)
    expect(usage.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: '格式参考模板' }))
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input!, {
      target: { files: [new File(['word'], 'custom-proposal.docx', { type: 'application/zip' })] },
    })
    await waitFor(() => {
      expect(b.uploadTemplate).toHaveBeenCalledWith({
        fileName: 'custom-proposal.docx',
        contentBase64: 'd29yZA==',
        name: 'custom-proposal',
        usage: 'format-reference',
      })
    })
  })

  it('localizes a template upload failure without exposing its internal diagnostic', async () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'gate',
      document: documentSnapshot(),
      templates: { ...TEMPLATE_CATALOG, contracts: [] },
    }))
    b.uploadTemplate.mockResolvedValueOnce({ ok: false, error: 'provider upload stack' })
    const view = render(<DocumentWorkbench {...b.props} />)
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input!, {
      target: { files: [new File(['word'], 'broken.docx', { type: 'application/zip' })] },
    })

    expect(await screen.findByText('未能上传 Word 模板，请确认文件可用后重试。')).not.toBeNull()
    expect(screen.queryByText('provider upload stack')).toBeNull()
  })

  it('shows parsed requirements before confirmation and links only a confirmed template', () => {
    const draft = workbenchProps(workbenchState({
      phase: 'ready', tab: 'gate', document: documentSnapshot(), templates: TEMPLATE_CATALOG,
    }))
    const view = render(<DocumentWorkbench {...draft.props} />)

    expect(screen.queryByText('必填字段：题目')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '我已审阅这些要求' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看 2 项解析要求' }))
    expect(screen.getByText('必填字段：题目')).not.toBeNull()
    expect(screen.getByText('开题报告必须填写论文题目。')).not.toBeNull()
    expect(screen.getByText('required-field · 置信度 98%')).not.toBeNull()
    const confirm = screen.getByRole('button', { name: '确认为交付标准' })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '我已审阅这些要求' }))
    expect(confirm.hasAttribute('disabled')).toBe(false)
    fireEvent.click(confirm)
    expect(draft.confirmTemplate).toHaveBeenCalledWith(HIT_TEMPLATE_ID)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(draft.loadTemplates).toHaveBeenCalledOnce()

    view.unmount()
    const confirmed = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'gate',
      document: {
        ...documentSnapshot(),
        template: {
          templateId: 'same-name-other-template',
          name: 'HIT master thesis proposal',
          source: 'built-in',
        },
      },
      templates: CONFIRMED_TEMPLATE_CATALOG,
    }))
    render(<DocumentWorkbench {...confirmed.props} />)
    fireEvent.click(screen.getByRole('button', { name: '关联到文档' }))
    expect(confirmed.associateTemplate).toHaveBeenCalledWith(HIT_TEMPLATE_ID)
  })

  it('exports drafts and formal copies, then locks both while a node draft is dirty', () => {
    const clean = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'gate',
      document: documentSnapshot(),
      templates: TEMPLATE_CATALOG,
      exportReceipt: {
        mode: 'draft-export',
        fileName: 'Master-thesis-draft.docx',
        outputPath: 'F:/paper/outputs/Master-thesis-draft.docx',
      },
    }))
    const view = render(<DocumentWorkbench {...clean.props} />)
    expect(screen.getByText('草稿已导出')).not.toBeNull()
    expect(screen.getByText('F:/paper/outputs/Master-thesis-draft.docx')).not.toBeNull()
    expect(screen.getByText('当前版本未通过模板门禁，正式版会被阻止导出；请先修正未满足项并重新运行门禁。'))
      .not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '导出草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '导出正式版' }))
    expect(clean.exportDocument).toHaveBeenNthCalledWith(1, 'draft-export')
    expect(clean.exportDocument).toHaveBeenNthCalledWith(2, 'delivery-export')

    view.unmount()
    const dirty = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'gate',
      document: documentSnapshot(),
      nodePhase: 'ready',
      selectedNode: textNodeBuffer(),
      draft: 'Unsaved requirement',
      dirty: true,
      templates: TEMPLATE_CATALOG,
    }))
    render(<DocumentWorkbench {...dirty.props} />)
    expect(screen.getByText('请先提交或放弃当前节点的临时修改，再导出。')).not.toBeNull()
    expect(screen.getByRole('button', { name: '导出草稿' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '导出正式版' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '运行门禁' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps draft export available but explains why formal export needs a linked template', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      tab: 'gate',
      document: { ...documentSnapshot(), template: null },
      templates: TEMPLATE_CATALOG,
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByRole('button', { name: '导出草稿' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '导出正式版' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('请先确认并关联一个适用模板，才能导出正式版。')).not.toBeNull()
  })

  it('renders a Remote failure with only its backed retry action', () => {
    const b = workbenchProps(workbenchState({ phase: 'error', error: 'internal: Host capability unavailable' }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('暂时无法打开文档。')).not.toBeNull()
    expect(screen.queryByText('internal: Host capability unavailable')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }))
    expect(b.retryOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '提交并创建版本' })).toBeNull()
    expect(screen.queryByRole('button', { name: '运行门禁' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复此版本' })).toBeNull()
  })
})
