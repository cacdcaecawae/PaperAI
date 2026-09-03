import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { vi } from 'vitest'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  ProjectId,
  TemplateContractId,
  TemplateRuleId,
  type DocumentCommit,
  type DocumentNode,
  type DocumentRecord,
  type GateReport,
  type ProjectRecord,
  type TemplateContract,
} from '@paperai/domain'
import { TemplatePackId } from '@paperai/template-service'
import { createPaperMcpServer } from '../src/server.ts'
import type {
  PaperMcpAccessScope,
  PaperMcpAgentIdentity,
  PaperMcpDependencies,
  PaperMcpExportAdapter,
} from '../src/types.ts'

export const actor: PaperMcpAgentIdentity = {
  kind: 'agent',
  name: 'Codex',
  client: 'codex',
  provider: 'openai',
  model: 'gpt-5.6-codex',
  sessionId: 'session-paperai',
}

export const project: ProjectRecord = {
  id: ProjectId('project-1'),
  workspaceId: 'workspace-1',
  name: 'Thesis',
  rootPath: 'C:\\papers\\thesis',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}

export const document: DocumentRecord = {
  id: DocumentId('document-1'),
  projectId: project.id,
  name: 'proposal',
  role: 'proposal',
  immutableSourcePath: 'C:\\papers\\thesis\\sources\\proposal.docx',
  workingPath: 'C:\\papers\\thesis\\working\\proposal.docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sourceSha256: 'a'.repeat(64),
  headCommitId: DocumentCommitId('commit-head'),
  nodeCount: 3,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}

/** A document of another project, reachable by id but outside the lease's workspace. */
export const foreignDocument: DocumentRecord = {
  ...document,
  id: DocumentId('document-2'),
  projectId: ProjectId('project-2'),
  name: 'other-proposal',
  immutableSourcePath: 'C:\\papers\\other\\sources\\proposal.docx',
  workingPath: 'C:\\papers\\other\\working\\proposal.docx',
}

/** The lease scope of a session opened at the project root with workspace-write. */
export function workspaceScope(
  workspaceRoot: string = project.rootPath,
  sandboxMode: () => 'read-only' | 'workspace-write' | 'danger-full-access' = () => 'workspace-write',
): PaperMcpAccessScope {
  return { workspaceRoot, sandboxMode }
}

export const nodes: DocumentNode[] = [0, 1, 2].map(ordinal => ({
  id: DocumentNodeId(`node-${ordinal}`),
  documentId: document.id,
  officePath: `/document/body/p[${ordinal + 1}]`,
  ordinal,
  kind: ordinal === 0 ? 'heading' : 'paragraph',
  text: `paragraph ${ordinal}`,
  style: { font: '宋体', size: 12 },
  hash: String(ordinal).repeat(64),
  lineage: [],
  ...(document.headCommitId === undefined ? {} : { lastCommitId: document.headCommitId }),
  updatedAt: document.updatedAt,
}))

export const template: TemplateContract = {
  id: TemplateContractId('template-1'),
  projectId: project.id,
  name: 'HIT proposal',
  sourceDocumentId: document.id,
  version: 1,
  rules: [{
    id: TemplateRuleId('rule-1'),
    kind: 'required-section',
    label: 'Research plan',
    description: 'A research plan is required.',
    severity: 'error',
    expected: 'Research plan',
    evidence: [],
    confidence: 1,
    enabled: true,
  }],
  slots: [],
  fixedNodeIds: [],
  instructionNodeIds: [],
  pageSetup: {},
  styleMap: {},
  origin: {
    kind: 'built-in',
    label: 'HIT',
    originalFileName: 'proposal.docx',
    packId: 'hit-master',
  },
  appliesToRoles: ['proposal'],
  usage: 'form-template',
  status: 'confirmed',
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
}

export function gate(status: GateReport['status'] = 'pass'): GateReport {
  return {
    status,
    mode: 'delivery-export',
    documentId: document.id,
    templateId: template.id,
    findings: status === 'fail'
      ? [{ id: 'finding-1', severity: 'error', code: 'REQUIRED', message: 'missing section' }]
      : [],
    checkedAt: '2026-08-28T00:00:00.000Z',
  }
}

export function commit(identity: PaperMcpAgentIdentity = actor): DocumentCommit {
  return {
    id: DocumentCommitId('commit-next'),
    documentId: document.id,
    ...(document.headCommitId === undefined ? {} : { parentId: document.headCommitId }),
    message: 'Improve introduction',
    actor: structuredClone(identity),
    snapshotPath: 'C:\\papers\\thesis\\history\\commit-next.docx',
    documentSha256: 'b'.repeat(64),
    gate: gate('pass'),
    operations: [],
    createdAt: '2026-08-28T00:01:00.000Z',
  }
}

export interface FakeDomain {
  readonly dependencies: PaperMcpDependencies
  readonly submit: ReturnType<typeof vi.fn>
  readonly revert: ReturnType<typeof vi.fn>
  readonly check: ReturnType<typeof vi.fn>
}

export function fakeDomain(report: GateReport = gate('pass')): FakeDomain {
  const submit = vi.fn(async (request: { actor: PaperMcpAgentIdentity }) => commit(request.actor))
  const revert = vi.fn(async (request: { actor: PaperMcpAgentIdentity }) => commit(request.actor))
  const check = vi.fn(async (request: { mode: GateReport['mode'] }) => ({ ...report, mode: request.mode }))
  return {
    submit,
    revert,
    check,
    dependencies: {
      projects: {
        get: vi.fn(id => id === project.id ? project : undefined),
        list: vi.fn(() => [project]),
        resolveForPath: vi.fn((path: string) => Promise.resolve(
          path === project.rootPath || path.startsWith(`${project.rootPath}\\`) ? project : undefined,
        )),
      },
      documents: {
        listDocuments: vi.fn(projectId => projectId === project.id ? [document] : []),
        readDocument: vi.fn(documentId => documentId === document.id
          ? { document, nodes }
          : documentId === foreignDocument.id
            ? { document: foreignDocument, nodes }
            : undefined),
      },
      templates: {
        check,
        getContract: vi.fn(id => id === template.id ? template : undefined),
        listContracts: vi.fn(projectId => projectId === project.id ? [template] : []),
        listPacks: vi.fn(() => [{
          id: TemplatePackId('hit-master'),
          name: 'HIT Master',
          description: 'Built-in templates',
          version: '1',
          sourceLabel: 'HIT',
          members: [],
        }]),
      },
      commits: {
        listHistory: vi.fn(() => [commit()]),
        submit: submit as never,
        revert: revert as never,
      },
    },
  }
}

export async function mcpHarness(
  domain: FakeDomain = fakeDomain(),
  exportAdapter?: PaperMcpExportAdapter,
  identity: PaperMcpAgentIdentity = actor,
  scope: PaperMcpAccessScope = workspaceScope(),
) {
  const server = createPaperMcpServer(domain.dependencies, identity, scope, {
    defaultNodesPerRead: 2,
    maxNodesPerRead: 3,
    maxMutationsPerCommit: 4,
  }, exportAdapter)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'paperai-mcp-test', version: '1' })
  await client.connect(clientTransport)
  return {
    client,
    domain,
    async close() {
      await client.close()
      await server.close()
    },
  }
}
