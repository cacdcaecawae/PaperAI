// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { DocumentWorkbench } from '../src/client/DocumentWorkbench.tsx'
import { StartPage } from '../src/client/StartPage.tsx'
import { TemplateLibraryView, TemplatesSection } from '../src/client/TemplateLibrary.tsx'
import { WorkspaceContent } from '../src/client/WorkspaceContent.tsx'
import { zh } from '../src/client/locales.ts'
import type {
  PaperAIDocumentWorkbenchProps, PaperAIStartPageProps, PaperAITemplatesSectionProps, PaperAIWorkspaceContentProps,
} from '../src/client/slots.ts'
import type {
  PaperAILibraryState, PaperAIProjectDirectoryState, PaperAIProjectState, PaperAIWorkbenchState,
} from '../src/client/types.ts'
import {
  COMMIT_0, CUSTOM_PACK_ID, DIFF, documentSnapshot, HIT_PACK_ID, LIBRARY, NODE_PARAGRAPH,
  OVERVIEW, RESOURCE_ID, REVISION_2, SESSION_ID, UNDECIDED_OVERVIEW, WORKSPACE_ID,
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

const ok = { ok: true as const }

function projectState(overrides: Partial<PaperAIProjectState> = {}): PaperAIProjectState {
  return { phase: 'ready', overview: OVERVIEW, selected: null, error: null, action: null, actionError: null, ...overrides }
}

function libraryState(overrides: Partial<PaperAILibraryState> = {}): PaperAILibraryState {
  return { phase: 'ready', library: LIBRARY, error: null, action: null, actionError: null, ...overrides }
}

function workbenchState(overrides: Partial<PaperAIWorkbenchState> = {}): PaperAIWorkbenchState {
  return {
    phase: 'idle', document: null, edit: null, action: null, panel: null, diff: null, typeSuggestion: null,
    exportReceipt: null, externalUpdate: null, error: null, actionError: null, ...overrides,
  }
}

function libraryActions() {
  return {
    loadLibrary: vi.fn(async () => {}),
    createTemplateSet: vi.fn(async () => ok),
    deleteTemplateSet: vi.fn(async () => ok),
    addTemplateFormat: vi.fn(async () => ok),
    removeTemplateFormat: vi.fn(async () => ok),
  }
}

function workspaceProps(state: PaperAIProjectState) {
  const store = createSnapshotStore<PaperAIProjectDirectoryState>({ workspaces: { [WORKSPACE_ID]: state } })
  const ensureProject = vi.fn(async () => {})
  const refreshProject = vi.fn(async () => {})
  const openDocument = vi.fn(async () => {})
  const props = {
    workspaceId: WORKSPACE_ID, path: 'F:/paper', title: 'Paper', active: true,
    useProjects: bind(store), ensureProject, refreshProject, openDocument, t,
  } as unknown as PaperAIWorkspaceContentProps
  return { props, store, ensureProject, refreshProject, openDocument }
}

function startProps(state: PaperAIProjectState | null, library = libraryState()) {
  const projects = createSnapshotStore<PaperAIProjectDirectoryState>({
    workspaces: state === null ? {} : { [WORKSPACE_ID]: state },
  })
  const libraryStore = createSnapshotStore(library)
  const actions = libraryActions()
  const ensureProject = vi.fn(async () => {})
  const setProjectTemplate = vi.fn(async () => ok)
  const createFromTemplate = vi.fn(async () => ok)
  const importDocument = vi.fn(async () => ok)
  const openWorkspacePicker = vi.fn()
  const renderSlot = vi.fn(() => <svg data-testid="mark" />)
  const props = {
    sessionId: state === null ? undefined : SESSION_ID,
    workspaceId: state === null ? undefined : WORKSPACE_ID,
    openWorkspacePicker,
    useProjects: bind(projects),
    useLibrary: bind(libraryStore),
    renderSlot,
    ensureProject, setProjectTemplate, createFromTemplate, importDocument, ...actions, t,
  } as unknown as PaperAIStartPageProps
  return {
    props, projects, libraryStore, ensureProject, setProjectTemplate, createFromTemplate, importDocument,
    openWorkspacePicker, renderSlot, ...actions,
  }
}

function workbenchProps(state: PaperAIWorkbenchState, project: PaperAIProjectState = projectState()) {
  const store = createSnapshotStore(state)
  const projects = createSnapshotStore<PaperAIProjectDirectoryState>({ workspaces: { [WORKSPACE_ID]: project } })
  const libraryStore = createSnapshotStore(libraryState())
  const actions = libraryActions()
  const callbacks = {
    closeDetails: vi.fn(),
    setDraft: vi.fn(),
    retryOpen: vi.fn(async () => {}),
    showPanel: vi.fn(),
    selectBlock: vi.fn(() => ok),
    updateDraft: vi.fn(),
    cancelEdit: vi.fn(),
    commitEdit: vi.fn(async () => ok),
    validate: vi.fn(async () => ok),
    suggestType: vi.fn(async () => ok),
    applyTemplate: vi.fn(async () => ok),
    detachTemplate: vi.fn(async () => ok),
    setProjectTemplate: vi.fn(async () => ok),
    showDiff: vi.fn(async () => ok),
    restore: vi.fn(async () => ok),
    exportDocument: vi.fn(async () => ok),
    reloadExternal: vi.fn(async () => ok),
    setDetailsFocus: vi.fn(),
  }
  const props = {
    sessionId: SESSION_ID,
    useWorkbench: bind(store), useProjects: bind(projects), useLibrary: bind(libraryStore),
    ...callbacks, ...actions, t,
  } as unknown as PaperAIDocumentWorkbenchProps
  return { props, store, projects, ...callbacks, ...actions }
}

describe('WorkspaceContent', () => {
  it('lists only tracked documents with their types and opens one on click', async () => {
    const b = workspaceProps(projectState({ selected: RESOURCE_ID }))
    render(<WorkspaceContent {...b.props} />)
    await waitFor(() => { expect(b.ensureProject).toHaveBeenCalledWith(WORKSPACE_ID) })
    expect(screen.getByRole('heading', { name: '文档', level: 3 })).toBeTruthy()
    const row = screen.getByRole('button', { name: '打开 硕士学位论文开题报告.docx' })
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.textContent).toContain('开题报告')
    fireEvent.click(row)
    expect(b.openDocument).toHaveBeenCalledWith(WORKSPACE_ID, RESOURCE_ID)
    expect(screen.queryByText('模板')).toBeNull()
    expect(screen.queryByText('新建文档')).toBeNull()
  })

  it('shows loading, an empty hint, and a retryable failure', () => {
    const cold = workspaceProps(projectState({ phase: 'cold', overview: null }))
    const view = render(<WorkspaceContent {...cold.props} />)
    expect(screen.getByText('正在读取文档…')).toBeTruthy()
    view.unmount()

    const empty = workspaceProps(projectState({ overview: { ...OVERVIEW, documents: [] } }))
    render(<WorkspaceContent {...empty.props} />)
    expect(screen.getByRole('status').textContent).toBe('还没有文档。在中间的起始页新建或导入。')
    cleanup()

    const failed = workspaceProps(projectState({ phase: 'error', overview: null, error: 'Host offline' }))
    render(<WorkspaceContent {...failed.props} />)
    expect(screen.getByRole('alert').textContent).toContain('暂时无法读取文档。')
    expect(screen.getByRole('alert').textContent).not.toContain('Host offline')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(failed.refreshProject).toHaveBeenCalledWith(WORKSPACE_ID)
  })
})

describe('StartPage', () => {
  it('offers to create a project when the blank session has none', () => {
    const b = startProps(null)
    render(<StartPage {...b.props} />)
    expect(screen.getByText('PaperAI')).toBeTruthy()
    expect(screen.getByText('选择一个文件夹。已有项目会保留文档和模板选择。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建或打开项目' }))
    expect(b.openWorkspacePicker).toHaveBeenCalledOnce()
    expect(b.renderSlot).toHaveBeenCalledWith('paperai.start.mark', expect.objectContaining({ size: 34 }), { fallback: null })
  })

  it('shows the project template and one action per format, starting form templates directly', async () => {
    const b = startProps(projectState())
    const view = render(<StartPage {...b.props} />)
    await waitFor(() => { expect(b.ensureProject).toHaveBeenCalledWith(WORKSPACE_ID) })
    expect(screen.getByText('Paper')).toBeTruthy()
    expect(screen.getByText('本项目模板：HIT 硕士模板')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '从本项目模板新建开题报告' }))
    expect(b.createFromTemplate).toHaveBeenCalledWith(WORKSPACE_ID, { documentType: 'proposal' })

    // A formatting reference asks for the manuscript file first.
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: '导入 Word 初稿并套用学位论文格式' }))
    expect(click).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files: [new File(['word'], 'thesis.docx', { type: 'application/zip' })] } })
    await waitFor(() => {
      expect(b.createFromTemplate).toHaveBeenLastCalledWith(WORKSPACE_ID, {
        documentType: 'manuscript', upload: { fileName: 'thesis.docx', contentBase64: 'd29yZA==' },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '导入 Word，自由写' }))
    fireEvent.change(input, { target: { files: [new File(['word'], 'notes.docx', { type: 'application/zip' })] } })
    await waitFor(() => {
      expect(b.importDocument).toHaveBeenCalledWith(WORKSPACE_ID, { fileName: 'notes.docx', contentBase64: 'd29yZA==' })
    })
    fireEvent.change(input, { target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] } })
    expect((await screen.findByRole('alert')).textContent).toContain('请选择不超过 32 MB 的 .doc 或 .docx 文件。')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks an undecided project for its template once and records the answer', async () => {
    const b = startProps(projectState({ overview: UNDECIDED_OVERVIEW }))
    render(<StartPage {...b.props} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('本项目用哪套模板？')).toBeTruthy()
    expect(b.loadLibrary).toHaveBeenCalled()
    expect(screen.getByText('尚未选择本项目的模板')).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: '用于本项目' })[0]!)
    expect(b.setProjectTemplate).toHaveBeenCalledWith(WORKSPACE_ID, HIT_PACK_ID)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    // Choosing to write freely is an answer too.
    fireEvent.click(screen.getByRole('button', { name: '选择…' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '不用模板，自由写' }))
    expect(b.setProjectTemplate).toHaveBeenLastCalledWith(WORKSPACE_ID, null)
  })

  it('distinguishes a deleted template from choosing to write without one', async () => {
    const missing = startProps(projectState({
      overview: { ...OVERVIEW, templatePackId: 'custom-deleted', template: null },
    }))
    render(<StartPage {...missing.props} />)
    expect(screen.getByText('本项目的模板已不在模板库中')).toBeTruthy()
    expect(screen.queryByText('本项目不使用模板，自由写作')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更换…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('当前：不用模板')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '不用模板，自由写' }))
    expect(missing.setProjectTemplate).toHaveBeenCalledWith(WORKSPACE_ID, null)
  })

  it('reports a failed start without the Host diagnostic and retries a failed project read', () => {
    const failed = startProps(projectState({ actionError: 'paperai-workbench: no template set' }))
    render(<StartPage {...failed.props} />)
    expect(screen.getByRole('alert').textContent).toBe('未能新建文档，请重试。')
    cleanup()
    const unreadable = startProps(projectState({ phase: 'error', overview: null, error: 'offline' }))
    render(<StartPage {...unreadable.props} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(unreadable.ensureProject).toHaveBeenCalledTimes(2)
  })
})

describe('TemplateLibraryView', () => {
  it('renders sets with their formats, creates a custom set, and deletes one after confirmation', async () => {
    const actions = libraryActions()
    render(<TemplateLibraryView state={libraryState()} {...actions} t={t} />)
    await waitFor(() => { expect(actions.loadLibrary).toHaveBeenCalledOnce() })
    expect(screen.getByText('HIT 硕士模板')).toBeTruthy()
    expect(screen.getAllByText('内置')).toHaveLength(1)
    expect(screen.getByText('我们学院 2026 版')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '用于本项目' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '添加自定义模板' }))
    const name = screen.getByRole('textbox', { name: '模板名称' })
    expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(name, { target: { value: '新学院版' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(actions.createTemplateSet).toHaveBeenCalledWith({ name: '新学院版' })
    await waitFor(() => { expect(screen.queryByRole('textbox', { name: '模板名称' })).toBeNull() })

    fireEvent.click(screen.getByRole('button', { name: '删除：我们学院 2026 版' }))
    expect(actions.deleteTemplateSet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull()
    expect(actions.deleteTemplateSet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除：我们学院 2026 版' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(actions.deleteTemplateSet).toHaveBeenCalledWith(CUSTOM_PACK_ID)
    fireEvent.click(screen.getByRole('button', { name: '移除：开题报告' }))
    expect(actions.removeTemplateFormat).toHaveBeenCalledWith(CUSTOM_PACK_ID, 'proposal')
  })

  it('adds a format to a custom set from the chosen type, usage, and Word file', async () => {
    const actions = libraryActions()
    const view = render(<TemplateLibraryView state={libraryState()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '添加格式' }))
    const type = screen.getByRole('button', { name: '文档类型' })
    // The first type without a format is preselected.
    expect(type.textContent).toContain('中期报告')
    fireEvent.click(type)
    fireEvent.click(screen.getByRole('menuitem', { name: '学位论文' }))
    fireEvent.click(screen.getByRole('button', { name: '文件用途' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '排版参考的范例' }))
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.click(screen.getByRole('button', { name: '选择 Word 文件' }))
    fireEvent.change(input, { target: { files: [new File(['word'], '论文范例.docx', { type: 'application/zip' })] } })
    await waitFor(() => {
      expect(actions.addTemplateFormat).toHaveBeenCalledWith({
        packId: CUSTOM_PACK_ID, documentType: 'manuscript', usage: 'format-reference',
        name: '论文范例', fileName: '论文范例.docx', contentBase64: 'd29yZA==',
      })
    })
    await waitFor(() => { expect(screen.queryByRole('button', { name: '文档类型' })).toBeNull() })
  })

  it('shows the project choice, marks the current set, and reports failures plainly', () => {
    const actions = libraryActions()
    const choose = vi.fn(async () => ok)
    render(<TemplateLibraryView
      state={libraryState({ actionError: 'internal: library offline' })}
      project={{ packId: HIT_PACK_ID, decided: true, choosing: false, choose }}
      {...actions}
      t={t}
    />)
    expect(screen.getByText('当前项目模板')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '用于本项目' }))
    expect(choose).toHaveBeenCalledWith(CUSTOM_PACK_ID)
    fireEvent.click(screen.getByRole('button', { name: '不用模板，自由写' }))
    expect(choose).toHaveBeenCalledWith(null)
    expect(screen.getByRole('alert').textContent).toBe('操作未完成，请重试。')
    expect(screen.queryByText('library offline')).toBeNull()
    cleanup()

    render(<TemplateLibraryView state={libraryState({ phase: 'error', library: null, error: 'offline' })} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(actions.loadLibrary).toHaveBeenLastCalledWith(true)
  })

  it('renders the settings page around the same library', () => {
    const actions = libraryActions()
    const store = createSnapshotStore(libraryState())
    const props = { useLibrary: bind(store), close: vi.fn(), ...actions, t } as unknown as PaperAITemplatesSectionProps
    render(<TemplatesSection {...props} />)
    expect(screen.getByRole('heading', { name: '模板', level: 2 })).toBeTruthy()
    expect(screen.getByText('HIT 硕士模板')).toBeTruthy()
  })
})

describe('DocumentWorkbench', () => {
  it('renders in a blank current Session and closes through the generic host owner', () => {
    const b = workbenchProps(workbenchState({}))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('从左侧选择一份文档。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭文档' }))
    expect(b.closeDetails).toHaveBeenCalledOnce()
  })

  it('renders the document in a sealed shadow tree and edits one block in place', async () => {
    // One snapshot identity: the controller keeps the document while only the edit changes.
    const snapshot = documentSnapshot()
    const b = workbenchProps(workbenchState({ phase: 'ready', document: snapshot }))
    const view = render(<DocumentWorkbench {...b.props} />)
    const host = view.container.querySelector('[role="document"]')!
    const shadow = host.shadowRoot!
    expect(shadow.querySelector('script')).toBeNull()
    const closing = [...shadow.querySelectorAll('p')].find(p => p.textContent === 'Closing remarks')!
    expect(closing.hasAttribute('onclick')).toBe(false)
    expect(shadow.querySelector('style')?.textContent).toContain('p { margin: 0 }')

    // Clicking the paragraph resolves the node it renders.
    const paragraph = [...shadow.querySelectorAll('p')].find(p => p.textContent === 'Research background')!
    fireEvent.click(paragraph)
    expect(b.selectBlock).toHaveBeenCalledWith(NODE_PARAGRAPH)
    // The table cell has no editable node: the click reports an unmapped block.
    fireEvent.click(shadow.querySelector('td')!)
    expect(screen.getByRole('status').textContent).toBe('这一段暂时无法在此修改，可以让 Agent 修改。')

    act(() => {
      b.store.set(workbenchState({
        phase: 'ready', document: snapshot,
        edit: { nodeId: NODE_PARAGRAPH, baseText: 'Research background', draft: 'Research background' },
      }))
    })
    expect(screen.queryByText('这一段暂时无法在此修改，可以让 Agent 修改。')).toBeNull()
    const editor = shadow.querySelector('textarea')!
    expect(editor.value).toBe('Research background')
    expect(paragraph.hasAttribute('data-paperai-editing')).toBe(true)
    fireEvent.change(editor, { target: { value: 'Rewritten background' } })
    expect(b.updateDraft).toHaveBeenCalledWith('Rewritten background')
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(b.cancelEdit).toHaveBeenCalledOnce()
    act(() => {
      b.store.set(workbenchState({
        phase: 'ready', document: snapshot,
        edit: { nodeId: NODE_PARAGRAPH, baseText: 'Research background', draft: 'Rewritten background' },
      }))
    })
    const save = [...shadow.querySelectorAll('button')].find(button => button.textContent === '保存')!
    fireEvent.click(save)
    expect(b.commitEdit).toHaveBeenCalledOnce()
  })

  it('opens the template, gate, and versions panels from the toolbar and drafts an agent fix', () => {
    const b = workbenchProps(workbenchState({ phase: 'ready', document: documentSnapshot() }))
    render(<DocumentWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'HIT 开题报告' }))
    expect(b.showPanel).toHaveBeenCalledWith('template')
    fireEvent.click(screen.getByRole('button', { name: /门禁未通过 1/ }))
    expect(b.showPanel).toHaveBeenCalledWith('gate')
    fireEvent.click(screen.getByRole('button', { name: '版本 2' }))
    expect(b.showPanel).toHaveBeenCalledWith('versions')

    fireEvent.click(screen.getByRole('button', { name: '专注写作' }))
    expect(b.setDetailsFocus).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: '退出专注' }))
    expect(b.setDetailsFocus).toHaveBeenLastCalledWith(false)

    act(() => { b.store.set(workbenchState({ phase: 'ready', document: documentSnapshot(), panel: 'gate' })) })
    const gate = screen.getByRole('complementary', { name: '门禁' })
    expect(within(gate).getByText('Heading font')).toBeTruthy()
    expect(within(gate).getByText('位置：Chapter 1')).toBeTruthy()
    fireEvent.click(within(gate).getByRole('button', { name: '检查' }))
    expect(b.validate).toHaveBeenCalledOnce()
    fireEvent.click(within(gate).getByRole('button', { name: '让 Agent 修复' }))
    expect(b.setDraft).toHaveBeenCalledOnce()
    expect(String(b.setDraft.mock.calls[0]?.[0])).toContain('Heading font')
    fireEvent.click(within(gate).getByRole('button', { name: '关闭面板' }))
    expect(b.showPanel).toHaveBeenLastCalledWith(null)
  })

  it('applies the project template by type, guessing first, and detaches a bound format', async () => {
    const free = workbenchProps(workbenchState({
      phase: 'ready', panel: 'template',
      document: documentSnapshot(REVISION_2, { template: null, documentType: 'other', projectFormatAvailable: false }),
      typeSuggestion: { documentId: documentSnapshot().documentId, documentType: 'midterm', basis: 'title' },
    }))
    render(<DocumentWorkbench {...free.props} />)
    const panel = screen.getByRole('complementary', { name: '模板' })
    expect(within(panel).getByText('这份文档没有套用模板，自由写作。')).toBeTruthy()
    expect(within(panel).getByText('看起来像中期报告')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '这份文档是什么类型？' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '开题报告' }))
    fireEvent.click(within(panel).getByRole('button', { name: '按开题报告套用' }))
    expect(free.applyTemplate).toHaveBeenCalledWith('proposal')
    fireEvent.click(within(panel).getByRole('button', { name: '更换本项目模板…' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(free.loadLibrary).toHaveBeenCalled()
    cleanup()

    const bound = workbenchProps(workbenchState({ phase: 'ready', panel: 'template', document: documentSnapshot() }))
    render(<DocumentWorkbench {...bound.props} />)
    const boundPanel = screen.getByRole('complementary', { name: '模板' })
    expect(within(boundPanel).getByText('HIT 开题报告')).toBeTruthy()
    fireEvent.click(within(boundPanel).getByRole('button', { name: '2 项要求' }))
    expect(within(boundPanel).getByText('必填字段：题目')).toBeTruthy()
    fireEvent.click(within(boundPanel).getByRole('button', { name: '解除绑定' }))
    expect(bound.detachTemplate).toHaveBeenCalledOnce()
    // The bound type is already applied; the same type again is not offered.
    expect(within(boundPanel).getByRole('button', { name: '按开题报告套用' }).hasAttribute('disabled')).toBe(true)
    // A project without a template says so instead of offering types.
    cleanup()
    const noProjectTemplate = workbenchProps(
      workbenchState({ phase: 'ready', panel: 'template', document: documentSnapshot() }),
      projectState({ overview: { ...OVERVIEW, templatePackId: null, template: null } }),
    )
    render(<DocumentWorkbench {...noProjectTemplate.props} />)
    expect(screen.getByText('本项目未选用模板。')).toBeTruthy()
  })

  it('offers the document its own type again once the project switched template sets', () => {
    const switched = workbenchProps(
      workbenchState({ phase: 'ready', panel: 'template', document: documentSnapshot() }),
      projectState({
        overview: { ...OVERVIEW, templatePackId: CUSTOM_PACK_ID, template: LIBRARY.sets[1] ?? null },
      }),
    )
    render(<DocumentWorkbench {...switched.props} />)
    const panel = screen.getByRole('complementary', { name: '模板' })
    // The bound format came from the previous set, so re-applying is a real change.
    const apply = within(panel).getByRole('button', { name: '按开题报告套用' })
    expect(apply.hasAttribute('disabled')).toBe(false)
    fireEvent.click(apply)
    expect(switched.applyTemplate).toHaveBeenCalledWith('proposal')
  })

  it('offers the document its own type again once that format was replaced in the current set', () => {
    const currentSet = LIBRARY.sets[0]!
    const replacedSet = {
      ...currentSet,
      formats: currentSet.formats.map(format => (
        format.documentType === 'proposal' ? { ...format, sourceVersion: 'hit-v2' } : format
      )),
    }
    const replaced = workbenchProps(
      workbenchState({ phase: 'ready', panel: 'template', document: documentSnapshot() }),
      projectState({ overview: { ...OVERVIEW, template: replacedSet } }),
    )
    render(<DocumentWorkbench {...replaced.props} />)
    const panel = screen.getByRole('complementary', { name: '模板' })
    const apply = within(panel).getByRole('button', { name: '按开题报告套用' })
    expect(apply.hasAttribute('disabled')).toBe(false)
    fireEvent.click(apply)
    expect(replaced.applyTemplate).toHaveBeenCalledWith('proposal')
  })

  it('shows a deleted project template in the document panel and template dialog', async () => {
    const missing = workbenchProps(
      workbenchState({ phase: 'ready', panel: 'template', document: documentSnapshot() }),
      projectState({ overview: { ...OVERVIEW, templatePackId: 'custom-deleted', template: null } }),
    )
    render(<DocumentWorkbench {...missing.props} />)
    expect(screen.getByText('本项目的模板已不在模板库中')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更换本项目模板…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('当前：不用模板')).toBeNull()
    expect(within(dialog).getByRole('button', { name: '不用模板，自由写' })).toBeTruthy()
  })

  it('explains that the current draft must be saved or cancelled before navigation', () => {
    const editing = workbenchProps(workbenchState({
      phase: 'ready', document: documentSnapshot(), actionError: 'save or cancel the current block first',
    }))
    render(<DocumentWorkbench {...editing.props} />)
    expect(screen.getByRole('alert').textContent).toBe('请先保存或取消正在编辑的段落。')
  })

  it('lists versions with author badges, unfolds one version\'s changes, and restores', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready', panel: 'versions', document: documentSnapshot(),
      diff: { commitId: COMMIT_0, result: { ...DIFF, commitId: COMMIT_0, parentCommitId: null }, error: null },
    }))
    render(<DocumentWorkbench {...b.props} />)
    const panel = screen.getByRole('complementary', { name: '版本' })
    expect(within(panel).getByText('Codex · gpt-5.6')).toBeTruthy()
    expect(within(panel).getByText('当前')).toBeTruthy()
    expect(within(panel).getByText('初始版本')).toBeTruthy()
    expect(within(panel).getByText('Old introduction')).toBeTruthy()
    expect(within(panel).getByText('3 段未变')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '收起改动' }))
    expect(b.showDiff).toHaveBeenCalledWith(COMMIT_0)
    fireEvent.click(within(panel).getAllByRole('button', { name: '查看改动' })[0]!)
    expect(b.showDiff).toHaveBeenCalledWith(documentSnapshot().headCommitId)
    fireEvent.click(within(panel).getByRole('button', { name: '恢复到此版本' }))
    expect(b.restore).toHaveBeenCalledWith(COMMIT_0)
  })

  it('exports through the toolbar menu and shows receipts, blocks, and external updates', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready',
      document: documentSnapshot(),
      exportReceipt: { mode: 'draft-export', fileName: '开题报告-草稿.docx', outputPath: 'F:/paper/exports/drafts/开题报告-草稿.docx' },
      externalUpdate: { documentId: documentSnapshot().documentId, headCommitId: COMMIT_0 },
      actionError: 'delivery blocked by 1 template requirement',
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('草稿已导出')).toBeTruthy()
    expect(screen.getByText('F:/paper/exports/drafts/开题报告-草稿.docx')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('这一版未通过门禁，正式版未导出。')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(b.reloadExternal).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '导出正式版' }))
    expect(b.exportDocument).toHaveBeenCalledWith('delivery-export')
  })

  it('tells the writer when a refresh dropped the block draft', () => {
    const b = workbenchProps(workbenchState({
      phase: 'ready', document: documentSnapshot(), actionError: 'block changed externally; local draft dropped',
    }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByRole('alert').textContent).toBe('这一段已被其他会话修改，本地草稿已放弃。')
  })

  it('renders a Remote failure with only its backed retry action', () => {
    const b = workbenchProps(workbenchState({ phase: 'error', error: 'internal: Host capability unavailable' }))
    render(<DocumentWorkbench {...b.props} />)
    expect(screen.getByText('暂时无法打开文档。')).toBeTruthy()
    expect(screen.queryByText('internal: Host capability unavailable')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }))
    expect(b.retryOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '导出' })).toBeNull()
  })
})
