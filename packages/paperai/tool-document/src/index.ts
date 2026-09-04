/**
 * Native DSH document tools for the PaperAI writing agent. The ten tools keep
 * the exact `paperai_*` names and result fields of the PaperAI MCP surface so
 * the built-in agent, Codex, and Claude share one vocabulary; handlers
 * delegate to the same Host domain services, every call is scoped to the
 * project that owns the calling session's workspace, mutations honor the
 * session's sandbox mode, and every mutation stamps the calling DSH session
 * and its current request route as commit provenance. Named exports preserve
 * loader injection metadata.
 * @module @paperai/tool-document
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  PaperAccessError,
  ProjectId,
  TemplateContractId,
  assertMutationAllowed,
  assertProjectInScope,
  deliveryBlocked,
  summarizeGate,
  type ActorIdentity,
  type DocumentCommit,
  type DocumentMutation,
  type DocumentNode,
  type DocumentRole,
  type GateMode,
  type PaperAccessScope,
} from '@paperai/domain'
import type {} from '@paperai/project-service'
import type {} from '@paperai/document-service'
import type {} from '@paperai/template-service'
import type {} from '@paperai/commit-service'

export const name = 'paperai-tool-document'
export const inject = ['tools', 'sandboxPolicy', 'paperProjects', 'paperDocuments', 'paperTemplates', 'paperCommits']

/** Result and mutation bounds advertised in the tool schemas. */
export interface Config {
  /** Node-page size when a read names no `maxNodes`. */
  defaultNodesPerRead?: number
  /** Upper bound for one read's node page. */
  maxNodesPerRead?: number
  /** Maximum ordered mutations in one document commit. */
  maxMutationsPerCommit?: number
}

/** Schemastery configuration mirroring the PaperAI MCP defaults. */
export const Config: z<Config> = z.object({
  defaultNodesPerRead: z.number().default(80),
  maxNodesPerRead: z.number().default(200),
  maxMutationsPerCommit: z.number().default(64),
})

/** Provenance stamped on every commit created through these tools. */
const DSH_CLIENT = 'dsh'

const gateModeSpec = {
  type: 'string',
  enum: ['continuous', 'draft-export', 'delivery-export'],
} as const

const exportModeSpec = {
  type: 'string',
  enum: ['draft-export', 'delivery-export'],
} as const

const documentRoleSpec = {
  type: 'string',
  enum: ['manuscript', 'proposal', 'midterm', 'final', 'other'],
} as const

const mutationSpec = {
  description: 'One semantic document mutation.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'replace-text', required: true },
        nodeId: { type: 'string', required: true, description: 'Stable PaperAI semantic node id.' },
        baseText: { type: 'string', required: true, description: 'Exact text observed before editing.' },
        nextText: { type: 'string', required: true, description: 'Replacement text.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'insert-node', required: true },
        text: { type: 'string', required: true, description: 'Paragraph text to insert.' },
        afterNodeId: { type: 'string', description: 'Insert after this node.' },
        beforeNodeId: { type: 'string', description: 'Insert before this node.' },
        style: { type: 'string', description: 'Existing Word paragraph style name.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'delete-node', required: true },
        nodeId: { type: 'string', required: true, description: 'Stable PaperAI semantic node id.' },
        baseText: { type: 'string', description: 'Exact observed text for conflict detection.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'bind-template', required: true },
        templateId: { type: 'string', required: true, description: 'Confirmed compatible template contract id.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'unbind-template', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'set-document-type', required: true },
        documentType: {
          type: 'string',
          required: true,
          enum: ['manuscript', 'proposal', 'midterm', 'final', 'other'],
          description: 'Document type. Changing it drops a bound format unless the same commit binds another.',
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'milestone', required: true },
        label: { type: 'string', required: true, description: 'Version milestone label.' },
      },
    },
  ],
} as const

const gateSummarySpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['pass', 'pass-with-exceptions', 'fail'] },
    errorCount: { type: 'integer', required: true },
    warningCount: { type: 'integer', required: true },
    infoCount: { type: 'integer', required: true },
    topFindings: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', required: true },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
    },
    nextActions: { type: 'string', required: true },
  },
} as const

const commitResultSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commit: { type: 'json', required: true, description: 'Complete recoverable DocumentCommit record.' },
    provenance: { type: 'json', required: true, description: 'Actor identity recorded on the commit.' },
    gateSummary: { ...gateSummarySpec, required: true },
  },
} as const satisfies ValueSchemaSpec

function jsonText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Domain records are lossless JSON data by construction; this one documented
 * cast aligns them with the `json` schema nodes instead of re-declaring every
 * record field, and the registry still snapshots and validates the value.
 * @param value - domain record or record fragment to expose canonically.
 * @returns the same value typed as lossless JSON.
 */
function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

function requireId(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`INVALID_REQUEST: ${label} must be a non-blank id`)
  return trimmed
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`INVALID_REQUEST: ${label} must be non-blank`)
  return trimmed
}

function requireAgent(exec: ToolExecution): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new PaperAccessError('NO_PROJECT_FOR_SESSION', 'PaperAI document tools require a calling agent session')
  }
  return agent
}

/**
 * Resolve the commit provenance for the calling DSH agent session. The
 * provider and model come from the session's durable `request/header`, which
 * the loop writes before each model request, so a model switched through the
 * picker mid-session is what the version ledger records; the creation route
 * is the fallback before any request was made.
 * @param exec - live tool execution carrying the agent set by the agent loop.
 * @returns the actor stamped on commits created by this call.
 * @throws when no agent owns the call, because provenance would be untraceable.
 */
function agentActor(exec: ToolExecution): ActorIdentity {
  const agent = requireAgent(exec)
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  return {
    kind: 'agent',
    name: 'DSH',
    client: DSH_CLIENT,
    sessionId: String(agent.id),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

type MutationInput =
  | { type: 'replace-text'; nodeId: string; baseText: string; nextText: string }
  | { type: 'insert-node'; text: string; afterNodeId?: string; beforeNodeId?: string; style?: string }
  | { type: 'delete-node'; nodeId: string; baseText?: string }
  | { type: 'bind-template'; templateId: string }
  | { type: 'unbind-template' }
  | { type: 'set-document-type'; documentType: DocumentRole }
  | { type: 'milestone'; label: string }

/**
 * Map one schema-validated mutation onto the domain vocabulary, enforcing the
 * cross-field rules the schema DSL cannot express. Contract validity of a
 * `bind-template` target stays with `paperCommits.submit()`, whose
 * `validateAssociation` call owns confirmation and role compatibility.
 * @param input - schema-validated mutation from the model.
 * @returns the domain mutation submitted to the commit service.
 */
function toMutation(input: MutationInput): DocumentMutation {
  switch (input.type) {
    case 'replace-text':
      return {
        type: input.type,
        nodeId: DocumentNodeId(requireId(input.nodeId, 'nodeId')),
        baseText: input.baseText,
        nextText: input.nextText,
      }
    case 'insert-node': {
      if (input.afterNodeId !== undefined && input.beforeNodeId !== undefined) {
        throw new Error('INVALID_REQUEST: insert-node accepts afterNodeId or beforeNodeId, not both')
      }
      return {
        type: input.type,
        text: requireText(input.text, 'insert-node text'),
        ...(input.afterNodeId === undefined ? {} : { afterNodeId: DocumentNodeId(requireId(input.afterNodeId, 'afterNodeId')) }),
        ...(input.beforeNodeId === undefined ? {} : { beforeNodeId: DocumentNodeId(requireId(input.beforeNodeId, 'beforeNodeId')) }),
        ...(input.style === undefined ? {} : { style: requireText(input.style, 'style') }),
      }
    }
    case 'delete-node':
      return {
        type: input.type,
        nodeId: DocumentNodeId(requireId(input.nodeId, 'nodeId')),
        ...(input.baseText === undefined ? {} : { baseText: input.baseText }),
      }
    case 'bind-template':
      return { type: input.type, templateId: TemplateContractId(requireId(input.templateId, 'templateId')) }
    case 'unbind-template':
      return { type: input.type }
    case 'set-document-type':
      return { type: input.type, documentType: input.documentType }
    case 'milestone':
      return { type: input.type, label: requireText(input.label, 'milestone label') }
  }
}

function commitValue(commit: DocumentCommit) {
  return {
    commit: asJson(commit),
    provenance: asJson(commit.actor),
    gateSummary: summarizeGate(commit.gate),
  }
}

function renderCommit(value: { commit: JsonValue; gateSummary: { nextActions: string } }): { type: 'text'; text: string }[] {
  const record = typeof value.commit === 'object' && value.commit !== null && !Array.isArray(value.commit)
    ? value.commit
    : undefined
  return [{
    type: 'text',
    text: `已提交版本 ${typeof record?.id === 'string' ? record.id : '?'}：${value.gateSummary.nextActions}\n${JSON.stringify(value)}`,
  }]
}

function stripStyle(node: DocumentNode): Omit<DocumentNode, 'style'> {
  const { style: _style, ...rest } = node
  return rest
}

/**
 * Register the ten PaperAI document tools on the calling scope's tool registry.
 * @param ctx - context carrying `tools`, the sandbox policy, and the PaperAI domain services.
 * @param config - validated result and mutation bounds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const defaultNodesPerRead = config.defaultNodesPerRead ?? 80
  const maxNodesPerRead = config.maxNodesPerRead ?? 200
  const maxMutationsPerCommit = config.maxMutationsPerCommit ?? 64
  for (const [label, value] of Object.entries({ defaultNodesPerRead, maxNodesPerRead, maxMutationsPerCommit })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`paperai-tool-document: ${label} must be a positive safe integer`)
    }
  }
  if (defaultNodesPerRead > maxNodesPerRead) {
    throw new Error('paperai-tool-document: defaultNodesPerRead must not exceed maxNodesPerRead')
  }

  /**
   * The calling session's project and mutation permission: the sandbox policy
   * resolves the session's workspace root and effective mode exactly as the
   * filesystem tools do, and the project that owns that root is the only one
   * these tools may touch, whatever the mode.
   */
  const scopeFor = async (exec: ToolExecution): Promise<PaperAccessScope> => {
    const agent = requireAgent(exec)
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
    const project = await ctx.paperProjects.resolveForPath(policy.workspaceRoot)
    if (project === undefined) {
      throw new PaperAccessError(
        'NO_PROJECT_FOR_SESSION',
        `no PaperAI project owns this session's workspace '${policy.workspaceRoot}'; open the session inside a PaperAI project`,
      )
    }
    return { projectId: project.id, workspaceRoot: policy.workspaceRoot, sandboxMode: policy.mode }
  }

  const scopedDocument = async (exec: ToolExecution, rawId: string) => {
    const scope = await scopeFor(exec)
    const snapshot = ctx.paperDocuments.readDocument(DocumentId(requireId(rawId, 'documentId')))
    if (snapshot === undefined) {
      throw new Error(`DOCUMENT_NOT_FOUND: PaperAI document '${rawId}' was not found`)
    }
    assertProjectInScope(scope, snapshot.document.projectId, `document '${snapshot.document.id}'`)
    return { scope, snapshot }
  }

  const scopedProject = async (exec: ToolExecution, rawId: string): Promise<ProjectId> => {
    const scope = await scopeFor(exec)
    const projectId = ProjectId(requireId(rawId, 'projectId'))
    assertProjectInScope(scope, projectId, `project '${projectId}'`)
    return projectId
  }

  ctx.tools.register(defineTool({
    name: 'paperai_list_projects',
    description: 'List the PaperAI project that owns this session\'s workspace. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { projects: { type: 'array', required: true, items: { type: 'json' } } },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (_args, exec) => {
      const scope = await scopeFor(exec)
      const project = ctx.paperProjects.get(scope.projectId)
      return { projects: project === undefined ? [] : [asJson(project)] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_list_documents',
    description: 'List Working DOCX records in this session\'s PaperAI project. Read-only.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'PaperAI project id.' },
      role: { ...documentRoleSpec, description: 'Optional academic document role.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { documents: { type: 'array', required: true, items: { type: 'json' } } },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (args, exec) => ({
      documents: ctx.paperDocuments
        .listDocuments(await scopedProject(exec, args.projectId), args.role)
        .map(asJson),
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_read_document',
    description: 'Read metadata and a bounded page of semantic Word nodes. Read-only.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'PaperAI document id.' },
      offset: { type: 'integer', description: 'Zero-based node offset; defaults to 0.' },
      limit: { type: 'integer', description: 'Maximum nodes to return, capped by the deployment limit.' },
      includeStyle: { type: 'boolean', description: 'Include structured Word style properties.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          document: { type: 'json', required: true },
          nodes: { type: 'array', required: true, items: { type: 'json' } },
          page: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              offset: { type: 'integer', required: true },
              count: { type: 'integer', required: true },
              total: { type: 'integer', required: true },
              nextOffset: {
                required: true,
                oneOf: [{ type: 'integer' }, { type: 'null' }],
                description: 'Offset of the next page, or null when the read reached the end.',
              },
            },
          },
        },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (args, exec) => {
      const { snapshot } = await scopedDocument(exec, args.documentId)
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('INVALID_REQUEST: offset must be a non-negative integer')
      }
      const requested = args.limit ?? defaultNodesPerRead
      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new Error('INVALID_REQUEST: limit must be a positive integer')
      }
      const limit = Math.min(requested, maxNodesPerRead)
      const selected = snapshot.nodes.slice(offset, offset + limit)
      return {
        document: asJson(snapshot.document),
        nodes: (args.includeStyle === true ? selected : selected.map(stripStyle)).map(asJson),
        page: {
          offset,
          count: selected.length,
          total: snapshot.nodes.length,
          nextOffset: offset + selected.length < snapshot.nodes.length ? offset + selected.length : null,
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_list_templates',
    description: 'List built-in template packs and contracts compiled for this session\'s project. Read-only.',
    parameters: { projectId: { type: 'string', required: true, description: 'PaperAI project id.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          packs: { type: 'array', required: true, items: { type: 'json' } },
          contracts: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (args, exec) => ({
      packs: ctx.paperTemplates.listPacks().map(asJson),
      contracts: ctx.paperTemplates.listContracts(await scopedProject(exec, args.projectId)).map(asJson),
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_get_template',
    description: 'Read confirmed or draft rules, slots, evidence, and provenance for one template. Read the attached contract before drafting content it governs. Read-only.',
    parameters: { templateId: { type: 'string', required: true, description: 'PaperAI template contract id.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { template: { type: 'json', required: true } },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (args, exec) => {
      const scope = await scopeFor(exec)
      const template = ctx.paperTemplates.getContract(TemplateContractId(requireId(args.templateId, 'templateId')))
      if (template === undefined) {
        throw new Error(`TEMPLATE_NOT_FOUND: PaperAI template '${args.templateId}' was not found`)
      }
      assertProjectInScope(scope, template.projectId, `template '${template.id}'`)
      return { template: asJson(template) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_list_versions',
    description: 'List recoverable commits from the current document head toward the root. Read-only.',
    parameters: { documentId: { type: 'string', required: true, description: 'PaperAI document id.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { commits: { type: 'array', required: true, items: { type: 'json' } } },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (args, exec) => {
      const { snapshot } = await scopedDocument(exec, args.documentId)
      return { commits: ctx.paperCommits.listHistory(snapshot.document.id).map(asJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_check_gate',
    description: 'Run continuous, draft-export, or formal delivery checks without modifying the document.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'PaperAI document id.' },
      mode: { ...gateModeSpec, required: true, description: 'Gate mode.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'json', required: true } },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (args, exec) => {
      const { snapshot } = await scopedDocument(exec, args.documentId)
      return {
        report: asJson(await ctx.paperTemplates.check({ documentId: snapshot.document.id, mode: args.mode })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_prepare_export',
    description: 'Check an export and return its authoritative Working DOCX source. This read-only tool does not publish a file.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'PaperAI document id.' },
      mode: { ...exportModeSpec, required: true, description: 'Draft or formal delivery export.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true },
          sourcePath: { type: 'string', required: true },
          suggestedFileName: { type: 'string', required: true },
          headCommitId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          report: { type: 'json', required: true },
        },
      },
      render: (_args, value) => jsonText(value),
    },
    execute: async (args, exec) => {
      const { snapshot } = await scopedDocument(exec, args.documentId)
      const mode = args.mode as GateMode
      const report = await ctx.paperTemplates.check({ documentId: snapshot.document.id, mode })
      return {
        allowed: mode === 'draft-export' || !deliveryBlocked(report),
        sourcePath: snapshot.document.workingPath,
        suggestedFileName: `${snapshot.document.name}.docx`,
        headCommitId: snapshot.document.headCommitId ?? null,
        report: asJson(report),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_commit_document',
    description: 'Apply supported Working DOCX mutations through PaperAI and create one recoverable commit with Agent provenance. The result carries gateSummary from the continuous template gate: fix error-level findings before writing on.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'PaperAI document id.' },
      baseCommitId: { type: 'string', description: 'Document head observed before editing.' },
      message: { type: 'string', required: true, description: 'User-visible version message.' },
      mutations: {
        type: 'array',
        required: true,
        items: mutationSpec,
        description: 'Ordered semantic document mutations.',
      },
    },
    output: { schema: commitResultSpec, render: (_args, value) => renderCommit(value) },
    execute: async (args, exec) => {
      if (args.mutations.length === 0 || args.mutations.length > maxMutationsPerCommit) {
        throw new Error(`INVALID_REQUEST: mutations must contain 1..${maxMutationsPerCommit} entries`)
      }
      const { scope, snapshot } = await scopedDocument(exec, args.documentId)
      assertMutationAllowed(scope, 'paperai_commit_document')
      const commit = await ctx.paperCommits.submit({
        documentId: snapshot.document.id,
        ...(args.baseCommitId === undefined
          ? {}
          : { baseCommitId: DocumentCommitId(requireId(args.baseCommitId, 'baseCommitId')) }),
        message: requireText(args.message, 'message'),
        actor: agentActor(exec),
        mutations: args.mutations.map(mutation => toMutation(mutation)),
      })
      return commitValue(commit)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paperai_revert_document',
    description: 'Restore a reachable snapshot as a new recoverable child commit with Agent provenance.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'PaperAI document id.' },
      baseCommitId: { type: 'string', required: true, description: 'Current document head.' },
      targetCommitId: { type: 'string', required: true, description: 'Reachable historical commit to restore.' },
      message: { type: 'string', description: 'Optional version message.' },
    },
    output: { schema: commitResultSpec, render: (_args, value) => renderCommit(value) },
    execute: async (args, exec) => {
      const { scope, snapshot } = await scopedDocument(exec, args.documentId)
      assertMutationAllowed(scope, 'paperai_revert_document')
      const commit = await ctx.paperCommits.revert({
        documentId: snapshot.document.id,
        baseCommitId: DocumentCommitId(requireId(args.baseCommitId, 'baseCommitId')),
        targetCommitId: DocumentCommitId(requireId(args.targetCommitId, 'targetCommitId')),
        ...(args.message === undefined ? {} : { message: requireText(args.message, 'message') }),
        actor: agentActor(exec),
      })
      return commitValue(commit)
    },
  }))
}
