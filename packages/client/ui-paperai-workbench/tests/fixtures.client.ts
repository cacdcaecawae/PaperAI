import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  PaperAIDocumentCommitId, PaperAIDocumentCommitResult, PaperAIDocumentId,
  PaperAIDocumentNodeId, PaperAIDocumentOpenResult, PaperAIDocumentRevision,
  PaperAIDocumentSnapshot, PaperAIGateFindingId, PaperAIResourceId,
  PaperAIResourceList, PaperAISelectedNodeBuffer, PaperAITemplateCatalog,
  PaperAIWorkbenchRemote,
} from '../src/client/types.ts'

export const WORKSPACE_ID = 'workspace-paper' as WorkspaceId
export const SESSION_ID = 'session-paper' as SessionId
export const RESOURCE_ID = 'resource-paper' as PaperAIResourceId
export const DOCUMENT_ID = 'document-paper' as PaperAIDocumentId
const REVISION_1 = 'revision-1' as PaperAIDocumentRevision
export const REVISION_2 = 'revision-2' as PaperAIDocumentRevision
export const REVISION_3 = 'revision-3' as PaperAIDocumentRevision
export const REVISION_4 = 'revision-4' as PaperAIDocumentRevision
export const COMMIT_0 = 'commit-0' as PaperAIDocumentCommitId
export const COMMIT_1 = 'commit-1' as PaperAIDocumentCommitId
export const COMMIT_2 = 'commit-2' as PaperAIDocumentCommitId
export const COMMIT_3 = 'commit-3' as PaperAIDocumentCommitId
export const COMMIT_4 = 'commit-4' as PaperAIDocumentCommitId
export const NODE_HEADING = 'node-heading' as PaperAIDocumentNodeId
export const NODE_PARAGRAPH = 'node-paragraph' as PaperAIDocumentNodeId
const NODE_TABLE = 'node-table' as PaperAIDocumentNodeId
export const HIT_PACK_ID = 'hit-master-thesis'
export const HIT_PROPOSAL_MEMBER_ID = 'proposal'
export const HIT_TEMPLATE_ID = 'template-hit-proposal'
const UPLOADED_TEMPLATE_ID = 'template-custom-proposal'

export const RESOURCES: PaperAIResourceList = {
  workspaceId: WORKSPACE_ID,
  resources: [
    {
      id: RESOURCE_ID,
      category: 'document',
      kind: 'file',
      name: 'thesis.docx',
      path: 'documents/thesis.docx',
      depth: 0,
      openable: true,
      status: 'modified',
    },
    {
      id: 'template-folder' as PaperAIResourceId,
      category: 'template',
      kind: 'folder',
      name: 'HIT master',
      path: 'templates/HIT-master',
      depth: 0,
      openable: false,
    },
    {
      id: 'code-file' as PaperAIResourceId,
      category: 'code',
      kind: 'file',
      name: 'analysis.py',
      path: 'code/analysis.py',
      depth: 1,
      openable: false,
    },
  ],
}

function headFor(revision: PaperAIDocumentRevision): PaperAIDocumentCommitId {
  if (revision === REVISION_4) return COMMIT_4
  if (revision === REVISION_3) return COMMIT_3
  if (revision === REVISION_2) return COMMIT_2
  return COMMIT_1
}

export function textNodeBuffer(
  revision: PaperAIDocumentRevision = REVISION_1,
  text = 'Editable thesis',
  nodeId: PaperAIDocumentNodeId = NODE_HEADING,
): PaperAISelectedNodeBuffer {
  const paragraph = nodeId === NODE_PARAGRAPH
  return {
    documentId: DOCUMENT_ID,
    nodeId,
    label: paragraph ? 'Research background' : 'Introduction',
    kind: paragraph ? 'paragraph' : 'heading',
    baseRevision: revision,
    baseCommitId: headFor(revision),
    format: 'text',
    text,
  }
}

export function documentSnapshot(
  revision: PaperAIDocumentRevision = REVISION_1,
): PaperAIDocumentSnapshot {
  const headCommitId = headFor(revision)
  return {
    documentId: DOCUMENT_ID,
    resourceId: RESOURCE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    title: 'Master thesis',
    role: 'proposal',
    path: 'documents/thesis.docx',
    revision,
    headCommitId,
    previewHtml: '<!doctype html><html><body><h1>Thesis</h1></body></html>',
    nodes: [
      { nodeId: NODE_HEADING, kind: 'heading', label: 'Introduction', depth: 0, editable: true },
      { nodeId: NODE_PARAGRAPH, kind: 'paragraph', label: 'Research background', depth: 1, editable: true },
      { nodeId: NODE_TABLE, kind: 'table', label: 'Experiment results', depth: 0, editable: false },
    ],
    versions: [
      {
        commitId: headCommitId,
        parentCommitId: COMMIT_0,
        revision,
        createdAt: '2026-08-28T10:00:00.000Z',
        summary: 'Improve the introduction',
        actor: { kind: 'agent', name: 'Codex', client: 'Codex', model: 'gpt-5.6' },
        restorable: false,
      },
      {
        commitId: COMMIT_0,
        parentCommitId: null,
        revision: REVISION_1,
        createdAt: '2026-08-27T10:00:00.000Z',
        summary: 'Imported thesis',
        actor: { kind: 'human', name: 'ly' },
        restorable: true,
      },
    ],
    template: {
      templateId: HIT_TEMPLATE_ID,
      name: 'HIT master thesis',
      source: 'built-in',
      version: '2026',
    },
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
  }
}

export const TEMPLATE_CATALOG: PaperAITemplateCatalog = {
  workspaceId: WORKSPACE_ID,
  packs: [{
    packId: HIT_PACK_ID,
    name: 'HIT master thesis',
    description: 'Harbin Institute of Technology master thesis templates.',
    version: '2026',
    members: [{
      memberId: HIT_PROPOSAL_MEMBER_ID,
      name: 'Master thesis proposal',
      description: 'Proposal form and formatting requirements.',
      appliesToRoles: ['proposal'],
      usage: 'form-template',
      originalFileName: '硕士学位论文开题报告.docx',
    }],
  }],
  contracts: [{
    templateId: HIT_TEMPLATE_ID,
    name: 'HIT master thesis proposal',
    status: 'draft',
    source: 'built-in',
    appliesToRoles: ['proposal'],
    usage: 'form-template',
    ruleCount: 2,
    slotCount: 4,
    originPackId: HIT_PACK_ID,
    originMemberId: HIT_PROPOSAL_MEMBER_ID,
    requirements: [
      {
        ruleId: 'required-title',
        kind: 'required-field',
        label: '必填字段：题目',
        description: '开题报告必须填写论文题目。',
        severity: 'error',
        confidence: 0.98,
        enabled: true,
      },
      {
        ruleId: 'heading-font',
        kind: 'font',
        label: '标题字体',
        description: '一级标题使用规定黑体字号。',
        severity: 'warning',
        confidence: 0.91,
        enabled: true,
      },
    ],
  }],
}

const UPLOADED_TEMPLATE_CATALOG: PaperAITemplateCatalog = {
  ...TEMPLATE_CATALOG,
  contracts: [
    ...TEMPLATE_CATALOG.contracts,
    {
      templateId: UPLOADED_TEMPLATE_ID,
      name: 'Custom proposal template',
      status: 'draft',
      source: 'uploaded',
      appliesToRoles: ['proposal'],
      usage: 'format-reference',
      ruleCount: 1,
      slotCount: 0,
      requirements: [{
        ruleId: 'body-line-spacing',
        kind: 'paragraph',
        label: '正文行距',
        description: '正文使用模板规定的行距。',
        severity: 'warning',
        confidence: 0.86,
        enabled: true,
      }],
    },
  ],
}

export const CONFIRMED_TEMPLATE_CATALOG: PaperAITemplateCatalog = {
  ...UPLOADED_TEMPLATE_CATALOG,
  contracts: UPLOADED_TEMPLATE_CATALOG.contracts.map(contract => contract.templateId === HIT_TEMPLATE_ID
    ? { ...contract, status: 'confirmed' }
    : contract),
}

export function documentOpenResult(
  revision: PaperAIDocumentRevision = REVISION_1,
): PaperAIDocumentOpenResult {
  return { document: documentSnapshot(revision), selectedNode: textNodeBuffer(revision) }
}

function commitResult(
  revision: PaperAIDocumentRevision,
  createdCommitId: PaperAIDocumentCommitId,
  text: string,
): PaperAIDocumentCommitResult {
  return {
    document: documentSnapshot(revision),
    selectedNode: textNodeBuffer(revision, text),
    createdCommitId,
  }
}

export function successfulRemote(): PaperAIWorkbenchRemote {
  return {
    list: async () => ({ ok: true, value: RESOURCES }),
    open: async () => ({ ok: true, value: documentOpenResult() }),
    readNode: async request => ({
      ok: true,
      value: textNodeBuffer(
        request.revision,
        request.nodeId === NODE_PARAGRAPH ? 'Research background' : 'Editable thesis',
        request.nodeId,
      ),
    }),
    commit: async request => ({
      ok: true,
      value: commitResult(
        REVISION_2,
        COMMIT_2,
        request.mutations[0]?.type === 'replace-text'
          ? request.mutations[0].nextText
          : 'Editable thesis',
      ),
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
    restore: async () => ({
      ok: true,
      value: commitResult(REVISION_3, COMMIT_3, 'Restored thesis'),
    }),
    importDocument: async () => ({
      ok: true,
      value: {
        status: 'imported',
        opened: documentOpenResult(),
        createdCommitId: COMMIT_1,
      },
    }),
    createFromTemplate: async () => ({
      ok: true,
      value: {
        status: 'imported',
        opened: documentOpenResult(),
        createdCommitId: COMMIT_1,
      },
    }),
    listTemplates: async () => ({ ok: true, value: TEMPLATE_CATALOG }),
    installTemplatePack: async () => ({ ok: true, value: TEMPLATE_CATALOG }),
    uploadTemplate: async () => ({ ok: true, value: UPLOADED_TEMPLATE_CATALOG }),
    confirmTemplate: async () => ({ ok: true, value: CONFIRMED_TEMPLATE_CATALOG }),
    associateTemplate: async () => ({
      ok: true,
      value: commitResult(REVISION_2, COMMIT_2, 'Associated HIT template'),
    }),
    exportDocument: async (request) => {
      const [revision, createdCommitId] = request.baseRevision === REVISION_3
        ? [REVISION_4, COMMIT_4]
        : request.baseRevision === REVISION_2
          ? [REVISION_3, COMMIT_3]
          : [REVISION_2, COMMIT_2]
      return {
        ok: true,
        value: {
          status: 'success',
          ...commitResult(revision, createdCommitId, 'Exported thesis'),
          outputPath: request.mode === 'draft-export'
            ? 'F:/paper/outputs/Master-thesis-draft.docx'
            : 'F:/paper/outputs/Master-thesis-delivery.docx',
          fileName: request.mode === 'draft-export'
            ? 'Master-thesis-draft.docx'
            : 'Master-thesis-delivery.docx',
          gate: request.mode === 'delivery-export'
            ? { status: 'passed', findings: [] }
            : documentSnapshot().gate,
        },
      }
    },
  }
}
