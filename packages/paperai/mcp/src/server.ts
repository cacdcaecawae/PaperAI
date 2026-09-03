/**
 * PaperAI MCP server factory. Tool handlers delegate to Host-owned domain
 * services; this module owns only transport schemas and model-facing results.
 * @module @paperai/mcp/server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  PaperAccessError,
  ProjectId,
  TemplateContractId,
  assertMutationAllowed,
  assertProjectInScope,
  assertWriteWithinWorkspace,
  deliveryBlocked,
  summarizeGate,
  type ActorIdentity,
  type DocumentCommit,
  type DocumentMutation,
  type GateMode,
  type PaperAccessScope,
} from '@paperai/domain'
import type {
  PaperMcpAccessScope,
  PaperMcpAgentIdentity,
  PaperMcpDependencies,
  PaperMcpExportAdapter,
  PaperMcpToolLimits,
} from './types.ts'

/** Stable MCP tool names contributed by the PaperAI domain bridge. */
export const PAPERAI_MCP_TOOL_NAMES = [
  'paperai_list_projects',
  'paperai_list_documents',
  'paperai_read_document',
  'paperai_list_templates',
  'paperai_get_template',
  'paperai_list_versions',
  'paperai_check_gate',
  'paperai_prepare_export',
  'paperai_commit_document',
  'paperai_revert_document',
] as const

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const

const wordId = z.string().trim().min(1)
const documentRole = z.enum(['manuscript', 'proposal', 'midterm', 'final', 'other'])
const gateMode = z.enum(['continuous', 'draft-export', 'delivery-export'])

const replaceTextMutation = z.object({
  type: z.literal('replace-text'),
  nodeId: wordId.describe('Stable PaperAI semantic node id.'),
  baseText: z.string().describe('Exact text observed before editing.'),
  nextText: z.string().describe('Replacement text.'),
})

const insertNodeMutation = z.object({
  type: z.literal('insert-node'),
  text: z.string().min(1).describe('Paragraph text to insert.'),
  afterNodeId: wordId.optional().describe('Insert after this node.'),
  beforeNodeId: wordId.optional().describe('Insert before this node.'),
  style: z.string().trim().min(1).optional().describe('Existing Word paragraph style name.'),
})

const deleteNodeMutation = z.object({
  type: z.literal('delete-node'),
  nodeId: wordId.describe('Stable PaperAI semantic node id.'),
  baseText: z.string().optional().describe('Exact observed text for conflict detection.'),
})

const bindTemplateMutation = z.object({
  type: z.literal('bind-template'),
  templateId: wordId.describe('Confirmed compatible template contract id.'),
})

const milestoneMutation = z.object({
  type: z.literal('milestone'),
  label: z.string().trim().min(1).describe('Version milestone label.'),
})

const documentMutation = z.union([
  replaceTextMutation,
  insertNodeMutation,
  deleteNodeMutation,
  bindTemplateMutation,
  milestoneMutation,
])

class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PaperMcpToolFailure'
  }
}

function cloneActor(actor: PaperMcpAgentIdentity): ActorIdentity {
  return structuredClone(actor)
}

function success(result: unknown) {
  const structuredContent = { result }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

function failure(error: unknown) {
  const code = error instanceof ToolFailure
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'PAPERAI_OPERATION_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  const details = error instanceof ToolFailure ? error.details : undefined
  const structuredContent = {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  }
}

async function execute(operation: () => unknown) {
  try {
    return success(await operation())
  } catch (error) {
    return failure(error)
  }
}

function requireDocument(dependencies: PaperMcpDependencies, rawId: string) {
  const snapshot = dependencies.documents.readDocument(DocumentId(rawId))
  if (snapshot === undefined) {
    throw new ToolFailure('DOCUMENT_NOT_FOUND', `PaperAI document '${rawId}' was not found`)
  }
  return snapshot
}

function validateTemplateBindings(
  dependencies: PaperMcpDependencies,
  documentId: string,
  mutations: readonly DocumentMutation[],
): void {
  const bindings = mutations.filter(
    (mutation): mutation is Extract<DocumentMutation, { type: 'bind-template' }> =>
      mutation.type === 'bind-template',
  )
  if (bindings.length === 0) return
  const document = requireDocument(dependencies, documentId).document
  for (const binding of bindings) {
    const contract = dependencies.templates.getContract(binding.templateId)
    if (contract === undefined) {
      throw new ToolFailure(
        'TEMPLATE_NOT_FOUND',
        `PaperAI template '${binding.templateId}' was not found`,
      )
    }
    if (contract.status !== 'confirmed') {
      throw new ToolFailure(
        'TEMPLATE_NOT_CONFIRMED',
        `PaperAI template '${contract.id}' must be confirmed before binding`,
        { templateId: contract.id, status: contract.status },
      )
    }
    if (!contract.appliesToRoles.includes(document.role)) {
      throw new ToolFailure(
        'TEMPLATE_ROLE_INCOMPATIBLE',
        `PaperAI template '${contract.id}' does not apply to document role '${document.role}'`,
        {
          templateId: contract.id,
          documentRole: document.role,
          appliesToRoles: contract.appliesToRoles,
        },
      )
    }
  }
}

function toMutation(input: z.infer<typeof documentMutation>): DocumentMutation {
  switch (input.type) {
    case 'replace-text':
      return {
        type: input.type,
        nodeId: DocumentNodeId(input.nodeId),
        baseText: input.baseText,
        nextText: input.nextText,
      }
    case 'insert-node':
      if (input.afterNodeId !== undefined && input.beforeNodeId !== undefined) {
        throw new ToolFailure(
          'INVALID_REQUEST',
          'insert-node accepts afterNodeId or beforeNodeId, not both',
        )
      }
      return {
        type: input.type,
        text: input.text,
        ...(input.afterNodeId === undefined
          ? {}
          : { afterNodeId: DocumentNodeId(input.afterNodeId) }),
        ...(input.beforeNodeId === undefined
          ? {}
          : { beforeNodeId: DocumentNodeId(input.beforeNodeId) }),
        ...(input.style === undefined ? {} : { style: input.style }),
      }
    case 'delete-node':
      return {
        type: input.type,
        nodeId: DocumentNodeId(input.nodeId),
        ...(input.baseText === undefined ? {} : { baseText: input.baseText }),
      }
    case 'bind-template':
      return {
        type: input.type,
        templateId: TemplateContractId(input.templateId),
      }
    case 'milestone':
      return { type: input.type, label: input.label }
  }
}

function assertLimits(limits: PaperMcpToolLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`paperai-mcp: ${name} must be a positive safe integer`)
    }
  }
  if (limits.defaultNodesPerRead > limits.maxNodesPerRead) {
    throw new Error('paperai-mcp: defaultNodesPerRead must not exceed maxNodesPerRead')
  }
}

function commitResult(commit: DocumentCommit) {
  return { commit, provenance: commit.actor, gateSummary: summarizeGate(commit.gate) }
}

function sameActor(commit: DocumentCommit, actor: PaperMcpAgentIdentity): boolean {
  return commit.actor.kind === actor.kind
    && commit.actor.name === actor.name
    && commit.actor.client === actor.client
    && commit.actor.provider === actor.provider
    && commit.actor.model === actor.model
    && commit.actor.sessionId === actor.sessionId
}

/**
 * Create one MCP server bound to a single authenticated Agent identity and
 * access scope. Every tool resolves the project that owns the scope's
 * workspace root and refuses records of any other project; mutating tools
 * additionally refuse under the `read-only` sandbox mode, read per call.
 * @param dependencies - Narrow PaperAI service consumers used by tool handlers.
 * @param actor - Provenance written by every mutating tool.
 * @param scope - Session workspace root and live sandbox mode of the lease.
 * @param limits - Result and mutation bounds advertised in tool schemas.
 * @param exportAdapter - Optional formal export provider; omission hides the write tool.
 * @returns an unconnected MCP server ready for any SDK server transport.
 */
export function createPaperMcpServer(
  dependencies: PaperMcpDependencies,
  actor: PaperMcpAgentIdentity,
  scope: PaperMcpAccessScope,
  limits: PaperMcpToolLimits,
  exportAdapter?: PaperMcpExportAdapter,
): McpServer {
  assertLimits(limits)
  const server = new McpServer(
    { name: 'paperai-domain', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  const accessScope = async (): Promise<PaperAccessScope> => {
    const project = await dependencies.projects.resolveForPath(scope.workspaceRoot)
    if (project === undefined) {
      throw new PaperAccessError(
        'NO_PROJECT_FOR_SESSION',
        `no PaperAI project owns this session's workspace '${scope.workspaceRoot}'`,
      )
    }
    return { projectId: project.id, workspaceRoot: scope.workspaceRoot, sandboxMode: scope.sandboxMode() }
  }

  const scopedDocument = async (rawId: string) => {
    const access = await accessScope()
    const snapshot = requireDocument(dependencies, rawId)
    assertProjectInScope(access, snapshot.document.projectId, `document '${snapshot.document.id}'`)
    return { access, snapshot }
  }

  const scopedProject = async (rawId: string): Promise<ProjectId> => {
    const access = await accessScope()
    const projectId = ProjectId(rawId)
    assertProjectInScope(access, projectId, `project '${projectId}'`)
    return projectId
  }

  server.registerTool('paperai_list_projects', {
    title: 'List PaperAI projects',
    description: 'List the PaperAI project that owns this session\'s workspace. Read-only.',
    inputSchema: {},
    annotations: READ_ONLY_ANNOTATIONS,
  }, async () => execute(async () => {
    const access = await accessScope()
    const project = dependencies.projects.get(access.projectId)
    return { projects: project === undefined ? [] : [project] }
  }))

  server.registerTool('paperai_list_documents', {
    title: 'List project documents',
    description: 'List Working DOCX records in this session\'s PaperAI project. Read-only.',
    inputSchema: {
      projectId: wordId.describe('PaperAI project id.'),
      role: documentRole.optional().describe('Optional academic document role.'),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async input => execute(async () => ({
    documents: dependencies.documents.listDocuments(await scopedProject(input.projectId), input.role),
  })))

  server.registerTool('paperai_read_document', {
    title: 'Read a document section',
    description: 'Read metadata and a bounded page of semantic Word nodes. Read-only.',
    inputSchema: {
      documentId: wordId.describe('PaperAI document id.'),
      offset: z.number().int().min(0).default(0).describe('Zero-based node offset.'),
      limit: z.number().int().min(1).max(limits.maxNodesPerRead)
        .default(limits.defaultNodesPerRead)
        .describe('Maximum nodes to return.'),
      includeStyle: z.boolean().default(false).describe('Include structured Word style properties.'),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async input => execute(async () => {
    const { snapshot } = await scopedDocument(input.documentId)
    const selected = snapshot.nodes.slice(input.offset, input.offset + input.limit)
      .map(node => input.includeStyle ? node : (({ style: _style, ...rest }) => rest)(node))
    return {
      document: snapshot.document,
      nodes: selected,
      page: {
        offset: input.offset,
        count: selected.length,
        total: snapshot.nodes.length,
        nextOffset: input.offset + selected.length < snapshot.nodes.length
          ? input.offset + selected.length
          : null,
      },
    }
  }))

  server.registerTool('paperai_list_templates', {
    title: 'List template choices',
    description: 'List built-in template packs and contracts compiled for this session\'s project. Read-only.',
    inputSchema: { projectId: wordId.describe('PaperAI project id.') },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async input => execute(async () => ({
    packs: dependencies.templates.listPacks(),
    contracts: dependencies.templates.listContracts(await scopedProject(input.projectId)),
  })))

  server.registerTool('paperai_get_template', {
    title: 'Read a template contract',
    description: 'Read confirmed or draft rules, slots, evidence, and provenance for one template. Read the attached contract before drafting content it governs. Read-only.',
    inputSchema: { templateId: wordId.describe('PaperAI template contract id.') },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async input => execute(async () => {
    const access = await accessScope()
    const template = dependencies.templates.getContract(TemplateContractId(input.templateId))
    if (template === undefined) {
      throw new ToolFailure('TEMPLATE_NOT_FOUND', `PaperAI template '${input.templateId}' was not found`)
    }
    assertProjectInScope(access, template.projectId, `template '${template.id}'`)
    return { template }
  }))

  server.registerTool('paperai_list_versions', {
    title: 'List document versions',
    description: 'List recoverable commits from the current document head toward the root. Read-only.',
    inputSchema: { documentId: wordId.describe('PaperAI document id.') },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async input => execute(async () => {
    const { snapshot } = await scopedDocument(input.documentId)
    return { commits: dependencies.commits.listHistory(snapshot.document.id) }
  }))

  server.registerTool('paperai_check_gate', {
    title: 'Check template requirements',
    description: 'Run continuous, draft-export, or formal delivery checks without modifying the document.',
    inputSchema: {
      documentId: wordId.describe('PaperAI document id.'),
      mode: gateMode.describe('Gate mode.'),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async input => execute(async () => {
    const { snapshot } = await scopedDocument(input.documentId)
    return {
      report: await dependencies.templates.check({
        documentId: snapshot.document.id,
        mode: input.mode,
      }),
    }
  }))

  server.registerTool('paperai_prepare_export', {
    title: 'Prepare a document export',
    description: 'Check an export and return its authoritative Working DOCX source. This read-only tool does not publish a file.',
    inputSchema: {
      documentId: wordId.describe('PaperAI document id.'),
      mode: z.enum(['draft-export', 'delivery-export']).describe('Draft or formal delivery export.'),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async input => execute(async () => {
    const { snapshot } = await scopedDocument(input.documentId)
    const report = await dependencies.templates.check({
      documentId: snapshot.document.id,
      mode: input.mode,
    })
    return {
      allowed: input.mode === 'draft-export' || !deliveryBlocked(report),
      sourcePath: snapshot.document.workingPath,
      suggestedFileName: `${snapshot.document.name}.docx`,
      headCommitId: snapshot.document.headCommitId ?? null,
      report,
    }
  }))

  server.registerTool('paperai_commit_document', {
    title: 'Commit document changes',
    description: 'Apply supported Working DOCX mutations through PaperAI and create one recoverable commit with Agent provenance. The result carries gateSummary from the continuous template gate: fix error-level findings before writing on.',
    inputSchema: {
      documentId: wordId.describe('PaperAI document id.'),
      baseCommitId: wordId.optional().describe('Document head observed before editing.'),
      message: z.string().trim().min(1).describe('User-visible version message.'),
      mutations: z.array(documentMutation).min(1).max(limits.maxMutationsPerCommit)
        .describe('Ordered semantic document mutations.'),
    },
    annotations: MUTATION_ANNOTATIONS,
  }, async input => execute(async () => {
    const { access, snapshot } = await scopedDocument(input.documentId)
    assertMutationAllowed(access, 'paperai_commit_document')
    const mutations = input.mutations.map(toMutation)
    validateTemplateBindings(dependencies, input.documentId, mutations)
    const commit = await dependencies.commits.submit({
      documentId: snapshot.document.id,
      ...(input.baseCommitId === undefined
        ? {}
        : { baseCommitId: DocumentCommitId(input.baseCommitId) }),
      message: input.message,
      actor: cloneActor(actor),
      mutations,
    })
    return commitResult(commit)
  }))

  server.registerTool('paperai_revert_document', {
    title: 'Revert to a document version',
    description: 'Restore a reachable snapshot as a new recoverable child commit with Agent provenance.',
    inputSchema: {
      documentId: wordId.describe('PaperAI document id.'),
      baseCommitId: wordId.describe('Current document head.'),
      targetCommitId: wordId.describe('Reachable historical commit to restore.'),
      message: z.string().trim().min(1).optional().describe('Optional version message.'),
    },
    annotations: MUTATION_ANNOTATIONS,
  }, async input => execute(async () => {
    const { access, snapshot } = await scopedDocument(input.documentId)
    assertMutationAllowed(access, 'paperai_revert_document')
    const commit = await dependencies.commits.revert({
      documentId: snapshot.document.id,
      baseCommitId: DocumentCommitId(input.baseCommitId),
      targetCommitId: DocumentCommitId(input.targetCommitId),
      ...(input.message === undefined ? {} : { message: input.message }),
      actor: cloneActor(actor),
    })
    return commitResult(commit)
  }))

  if (exportAdapter !== undefined) {
    server.registerTool('paperai_export_document', {
      title: 'Publish a checked DOCX',
      description: 'Publish a draft or formal delivery file through the configured PaperAI export provider and return its version commit.',
      inputSchema: {
        documentId: wordId.describe('PaperAI document id.'),
        destinationPath: z.string().trim().min(1).describe('Destination path handled by the export provider.'),
        mode: z.enum(['draft-export', 'delivery-export']).describe('Draft or formal delivery export.'),
      },
      annotations: MUTATION_ANNOTATIONS,
    }, async input => execute(async () => {
      const { access, snapshot } = await scopedDocument(input.documentId)
      assertMutationAllowed(access, 'paperai_export_document')
      // The Agent names the file; the session's sandbox mode decides where it may land.
      const destinationPath = assertWriteWithinWorkspace(access, input.destinationPath, 'export destination')
      const mode: GateMode = input.mode
      const report = await dependencies.templates.check({
        documentId: snapshot.document.id,
        mode,
      })
      if (deliveryBlocked(report)) {
        throw new ToolFailure(
          'DELIVERY_BLOCKED',
          `formal delivery for document '${snapshot.document.id}' is blocked by template errors`,
          { report },
        )
      }
      const result = await exportAdapter.exportDocument({
        document: snapshot.document,
        destinationPath,
        // The provider re-checks the real path at publish time, so a link
        // inside the workspace cannot carry the file out of it.
        ...access.sandboxMode === 'danger-full-access' ? {} : { writableRoot: access.workspaceRoot },
        mode,
        gate: report,
        actor: structuredClone(actor),
      })
      if (result.commit.documentId !== snapshot.document.id || !sameActor(result.commit, actor)) {
        throw new ToolFailure(
          'INVALID_EXPORT_PROVENANCE',
          'PaperAI export provider returned a commit for another document or Agent',
        )
      }
      return {
        outputPath: result.outputPath,
        gate: result.gate,
        ...commitResult(result.commit),
      }
    }))
  }

  return server
}
