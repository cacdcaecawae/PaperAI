import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  PaperAIDocumentCommitId, PaperAIDocumentCommitResult, PaperAIDocumentId, PaperAIDocumentNodeId,
  PaperAIDocumentOpenResult, PaperAIDocumentRevision, PaperAIDocumentSnapshot, PaperAIGateFindingId,
  PaperAIProjectOverview, PaperAIResourceId, PaperAITemplateLibrary, PaperAITemplateSetChoice,
  PaperAIVersionDiff, PaperAIWorkbenchRemote,
} from '../src/client/types.ts'

export const WORKSPACE_ID = 'workspace-paper' as WorkspaceId
export const SESSION_ID = 'session-paper' as SessionId
export const RESOURCE_ID = 'document:document-paper' as PaperAIResourceId
export const DOCUMENT_ID = 'document-paper' as PaperAIDocumentId
const REVISION_1 = 'revision-1' as PaperAIDocumentRevision
export const REVISION_2 = 'revision-2' as PaperAIDocumentRevision
const REVISION_3 = 'revision-3' as PaperAIDocumentRevision
export const COMMIT_0 = 'commit-0' as PaperAIDocumentCommitId
export const COMMIT_1 = 'commit-1' as PaperAIDocumentCommitId
export const COMMIT_2 = 'commit-2' as PaperAIDocumentCommitId
const COMMIT_3 = 'commit-3' as PaperAIDocumentCommitId
export const NODE_HEADING = 'node-heading' as PaperAIDocumentNodeId
export const NODE_PARAGRAPH = 'node-paragraph' as PaperAIDocumentNodeId
export const NODE_TABLE = 'node-table' as PaperAIDocumentNodeId
export const HIT_PACK_ID = 'hit-master-thesis'
export const CUSTOM_PACK_ID = 'custom-00000001'

const HIT_SET: PaperAITemplateSetChoice = {
  packId: HIT_PACK_ID,
  kind: 'built-in',
  name: 'HIT 硕士模板',
  description: '哈尔滨工业大学硕士学位论文开题、中期和论文书写模板',
  formats: [
    { memberId: 'proposal', documentType: 'proposal', name: '硕士学位论文开题报告', usage: 'form-template', sourceVersion: 'hit-v1', originalFileName: '开题.doc' },
    { memberId: 'midterm', documentType: 'midterm', name: '硕士学位论文中期报告', usage: 'form-template', sourceVersion: 'hit-v1', originalFileName: '中期.doc' },
    { memberId: 'thesis-format', documentType: 'manuscript', name: '研究生学位论文书写范例', usage: 'format-reference', sourceVersion: 'hit-v1', originalFileName: '范例.doc' },
  ],
}

const CUSTOM_SET: PaperAITemplateSetChoice = {
  packId: CUSTOM_PACK_ID,
  kind: 'custom',
  name: '我们学院 2026 版',
  description: '',
  formats: [
    { memberId: 'proposal', documentType: 'proposal', name: '学院开题模板', usage: 'form-template', sourceVersion: 'custom-v1', originalFileName: '学院开题.docx' },
  ],
}

export const LIBRARY: PaperAITemplateLibrary = { sets: [HIT_SET, CUSTOM_SET] }

export const OVERVIEW: PaperAIProjectOverview = {
  workspaceId: WORKSPACE_ID,
  projectName: 'Paper',
  templateDecided: true,
  templatePackId: HIT_PACK_ID,
  template: HIT_SET,
  documents: [{
    id: RESOURCE_ID,
    documentId: DOCUMENT_ID,
    name: '硕士学位论文开题报告',
    fileName: '硕士学位论文开题报告.docx',
    documentType: 'proposal',
    templateName: 'HIT 开题报告',
    updatedAt: '2026-08-28T10:00:00.000Z',
  }],
}

export const UNDECIDED_OVERVIEW: PaperAIProjectOverview = {
  ...OVERVIEW,
  templateDecided: false,
  templatePackId: null,
  template: null,
  documents: [],
}

const PREVIEW_HTML = '<html><head><style>p { margin: 0 }</style></head><body>'
  + '<h1>Introduction</h1><p>Research background</p><p></p>'
  + '<table><tr><td>Experiment results</td></tr></table>'
  + '<script>alert(1)</script><p onclick="alert(2)">Closing remarks</p>'
  + '</body></html>'

function headFor(revision: PaperAIDocumentRevision): PaperAIDocumentCommitId {
  if (revision === REVISION_3) return COMMIT_3
  if (revision === REVISION_2) return COMMIT_2
  return COMMIT_1
}

export function documentSnapshot(
  revision: PaperAIDocumentRevision = REVISION_1,
  overrides: Partial<PaperAIDocumentSnapshot> = {},
): PaperAIDocumentSnapshot {
  const headCommitId = headFor(revision)
  return {
    documentId: DOCUMENT_ID,
    resourceId: RESOURCE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    title: '硕士学位论文开题报告',
    documentType: 'proposal',
    path: 'documents/working/硕士学位论文开题报告.docx',
    revision,
    headCommitId,
    previewHtml: PREVIEW_HTML,
    nodes: [
      { nodeId: NODE_HEADING, kind: 'heading', label: 'Introduction', depth: 0, editable: true, text: 'Introduction' },
      { nodeId: NODE_PARAGRAPH, kind: 'paragraph', label: 'Research background', depth: 0, editable: true, text: 'Research background' },
      { nodeId: 'node-empty' as PaperAIDocumentNodeId, kind: 'paragraph', label: '空段落', depth: 0, editable: true, text: '' },
      { nodeId: NODE_TABLE, kind: 'table', label: 'Experiment results', depth: 0, editable: false, text: 'Experiment results' },
      { nodeId: 'node-closing' as PaperAIDocumentNodeId, kind: 'paragraph', label: 'Closing remarks', depth: 0, editable: true, text: 'Closing remarks' },
    ],
    versions: [
      {
        commitId: headCommitId,
        parentCommitId: COMMIT_0,
        revision,
        createdAt: '2026-08-28T10:00:00.000Z',
        summary: 'Improve the introduction',
        actor: { kind: 'agent', name: 'Codex', client: 'codex', model: 'gpt-5.6' },
        restorable: false,
      },
      {
        commitId: COMMIT_0,
        parentCommitId: null,
        revision: REVISION_1,
        createdAt: '2026-08-27T10:00:00.000Z',
        summary: '从模板新建：硕士学位论文开题报告',
        actor: { kind: 'human', name: '用户' },
        restorable: true,
      },
    ],
    template: {
      templateId: 'template-hit-proposal',
      name: 'HIT 开题报告',
      kind: 'built-in',
      packId: HIT_PACK_ID,
      packName: 'HIT 硕士模板',
      memberId: 'proposal',
      sourceVersion: 'hit-v1',
      usage: 'form-template',
      requirements: [
        { ruleId: 'required-title', kind: 'required-field', label: '必填字段：题目', description: '开题报告必须填写论文题目。', severity: 'error', enabled: true },
        { ruleId: 'heading-font', kind: 'font', label: '标题字体', description: '一级标题使用规定黑体字号。', severity: 'warning', enabled: true },
      ],
    },
    projectFormatAvailable: true,
    gate: {
      status: 'failed',
      checkedAt: '2026-08-28T10:01:00.000Z',
      findings: [{
        id: 'finding-1' as PaperAIGateFindingId,
        severity: 'error',
        title: 'Heading font',
        message: 'Use the required heading font.',
        location: 'Chapter 1',
        passed: false,
      }],
    },
    ...overrides,
  }
}

export function documentOpenResult(
  revision: PaperAIDocumentRevision = REVISION_1,
  overrides: Partial<PaperAIDocumentSnapshot> = {},
): PaperAIDocumentOpenResult {
  return { document: documentSnapshot(revision, overrides), selectedNode: null }
}

function commitResult(
  revision: PaperAIDocumentRevision,
  createdCommitId: PaperAIDocumentCommitId,
  overrides: Partial<PaperAIDocumentSnapshot> = {},
): PaperAIDocumentCommitResult {
  return { document: documentSnapshot(revision, overrides), selectedNode: null, createdCommitId }
}

export const DIFF: PaperAIVersionDiff = {
  documentId: DOCUMENT_ID,
  commitId: COMMIT_1,
  parentCommitId: COMMIT_0,
  changes: [
    { kind: 'changed', before: 'Old introduction', after: 'Introduction' },
    { kind: 'added', after: 'Research background' },
  ],
  unchangedCount: 3,
}

export function successfulRemote(): PaperAIWorkbenchRemote {
  return {
    agentDiagnostics: async () => ({ ok: true, value: [] }),
    probeAgent: async request => ({ ok: true, value: { provider: request.provider, status: 'discovered', executable: 'node', adapterVersion: null, agentVersion: null, checkedAt: null, retryAt: null, elapsedMs: null, error: null, models: [] } }),
    inspectProject: async () => ({ ok: true, value: { checkedAt: '2026-09-05T00:00:00Z', documents: 1, issues: [], repairs: [] } }),
    recoverWorking: async () => ({ ok: true, value: { checkedAt: '2026-09-05T00:00:00Z', documents: 1, issues: [], repairs: [] } }),
    overview: async () => ({ ok: true, value: OVERVIEW }),
    setProjectTemplate: async request => ({
      ok: true,
      value: {
        ...OVERVIEW,
        templateDecided: true,
        templatePackId: request.packId,
        template: request.packId === null ? null : LIBRARY.sets.find(set => set.packId === request.packId) ?? null,
      },
    }),
    listTemplateLibrary: async () => ({ ok: true, value: LIBRARY }),
    createTemplateSet: async request => ({
      ok: true,
      value: { sets: [...LIBRARY.sets, { packId: 'custom-00000002', kind: 'custom', name: request.name, description: request.description ?? '', formats: [] }] },
    }),
    deleteTemplateSet: async request => ({ ok: true, value: { sets: LIBRARY.sets.filter(set => set.packId !== request.packId) } }),
    addTemplateFormat: async () => ({ ok: true, value: LIBRARY }),
    removeTemplateFormat: async () => ({ ok: true, value: LIBRARY }),
    importDocument: async () => ({
      ok: true,
      value: { status: 'imported', opened: documentOpenResult(REVISION_1, { documentType: 'other', template: null }), createdCommitId: COMMIT_1 },
    }),
    createFromTemplate: async () => ({
      ok: true,
      value: { status: 'imported', opened: documentOpenResult(), createdCommitId: COMMIT_1 },
    }),
    open: async () => ({ ok: true, value: documentOpenResult() }),
    commit: async request => ({
      ok: true,
      value: commitResult(REVISION_2, COMMIT_2, {
        nodes: documentSnapshot().nodes.map(node => node.nodeId === request.mutations[0]?.nodeId
          ? { ...node, text: request.mutations[0].nextText, label: request.mutations[0].nextText }
          : node),
      }),
    }),
    validate: async request => ({
      ok: true,
      value: {
        documentId: DOCUMENT_ID,
        revision: request.revision,
        headCommitId: request.headCommitId,
        gate: { status: 'passed', findings: [] },
      },
    }),
    restore: async () => ({ ok: true, value: commitResult(REVISION_3, COMMIT_3) }),
    applyTemplate: async request => ({
      ok: true,
      value: commitResult(REVISION_2, COMMIT_2, { documentType: request.documentType }),
    }),
    detachTemplate: async () => ({ ok: true, value: commitResult(REVISION_2, COMMIT_2, { template: null }) }),
    suggestDocumentType: async () => ({ ok: true, value: { documentId: DOCUMENT_ID, documentType: 'proposal', basis: 'title' } }),
    diffVersion: async request => ({ ok: true, value: { ...DIFF, commitId: request.commitId } }),
    exportDocument: async request => ({
      ok: true,
      value: {
        status: 'success',
        ...(request.baseRevision === REVISION_2 ? commitResult(REVISION_3, COMMIT_3) : commitResult(REVISION_2, COMMIT_2)),
        outputPath: request.mode === 'draft-export'
          ? 'F:/paper/exports/drafts/开题报告-草稿.docx'
          : 'F:/paper/exports/delivery/开题报告.docx',
        fileName: request.mode === 'draft-export' ? '开题报告-草稿.docx' : '开题报告.docx',
        gate: request.mode === 'delivery-export' ? { status: 'passed', findings: [] } : documentSnapshot().gate,
      },
    }),
  }
}
