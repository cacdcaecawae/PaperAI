import { describe, expect, it, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { DocumentCommitId } from '@paperai/domain'
import { createPaperMcpServer, PAPERAI_MCP_TOOL_NAMES } from '../src/server.ts'
import type { PaperMcpExportAdapter } from '../src/types.ts'
import {
  actor,
  commit,
  document,
  fakeDomain,
  gate,
  mcpHarness,
  nodes,
  project,
  template,
} from './helpers.ts'

interface ToolResult {
  readonly isError?: boolean
  readonly structuredContent?: {
    readonly result?: Record<string, unknown>
    readonly error?: {
      readonly code: string
      readonly message: string
      readonly details?: Record<string, unknown>
    }
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return await client.callTool({ name, arguments: args }) as ToolResult
}

describe('PaperAI MCP server', () => {
  it('publishes a narrow read/write catalog with explicit safety annotations', async () => {
    const harness = await mcpHarness()
    try {
      const listed = await harness.client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(PAPERAI_MCP_TOOL_NAMES)
      expect(listed.tools.find(tool => tool.name === 'paperai_read_document')?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
      expect(listed.tools.find(tool => tool.name === 'paperai_commit_document')?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false })
      expect(listed.tools.find(tool => tool.name === 'paperai_commit_document')?.inputSchema)
        .not.toHaveProperty('properties.actor')
      expect(listed.tools).not.toContainEqual(expect.objectContaining({ name: 'paperai_export_document' }))
    } finally {
      await harness.close()
    }
  })

  it('reads bounded semantic nodes without styles unless explicitly requested', async () => {
    const harness = await mcpHarness()
    try {
      const first = await call(harness.client, 'paperai_read_document', {
        documentId: document.id,
      })
      expect(first.isError).not.toBe(true)
      expect(first.structuredContent?.result).toMatchObject({
        document,
        page: { offset: 0, count: 2, total: 3, nextOffset: 2 },
      })
      const firstNodes = first.structuredContent?.result?.nodes as Array<Record<string, unknown>>
      expect(firstNodes).toHaveLength(2)
      expect(firstNodes[0]).not.toHaveProperty('style')

      const styled = await call(harness.client, 'paperai_read_document', {
        documentId: document.id,
        offset: 2,
        limit: 1,
        includeStyle: true,
      })
      expect(styled.structuredContent?.result?.nodes).toEqual([nodes[2]])
    } finally {
      await harness.close()
    }
  })

  it('delegates mutations to paperCommits and returns descriptor-bound Agent provenance', async () => {
    const domain = fakeDomain()
    const harness = await mcpHarness(domain)
    try {
      const result = await call(harness.client, 'paperai_commit_document', {
        documentId: document.id,
        baseCommitId: document.headCommitId,
        message: 'Rewrite the opening',
        mutations: [
          {
            type: 'replace-text',
            nodeId: nodes[1]?.id,
            baseText: nodes[1]?.text,
            nextText: 'Rewritten paragraph',
          },
          {
            type: 'insert-node',
            text: 'A new paragraph',
            afterNodeId: nodes[1]?.id,
          },
        ],
      })

      expect(result.isError).not.toBe(true)
      expect(domain.submit).toHaveBeenCalledOnce()
      expect(domain.submit.mock.calls[0]?.[0]).toMatchObject({
        documentId: document.id,
        baseCommitId: document.headCommitId,
        message: 'Rewrite the opening',
        actor,
        mutations: [
          {
            type: 'replace-text',
            nodeId: nodes[1]?.id,
            baseText: nodes[1]?.text,
            nextText: 'Rewritten paragraph',
          },
          {
            type: 'insert-node',
            text: 'A new paragraph',
            afterNodeId: nodes[1]?.id,
          },
        ],
      })
      expect(result.structuredContent?.result).toMatchObject({
        commit: { documentId: document.id, actor },
        provenance: actor,
      })
    } finally {
      await harness.close()
    }
  })

  it('maps every supported mutation variant and rejects ambiguous insertion', async () => {
    const domain = fakeDomain()
    const harness = await mcpHarness(domain)
    try {
      const mapped = await call(harness.client, 'paperai_commit_document', {
        documentId: document.id,
        message: 'Structure and template update',
        mutations: [
          {
            type: 'insert-node',
            text: 'Before the conclusion',
            beforeNodeId: nodes[2]?.id,
            style: 'Body Text',
          },
          {
            type: 'delete-node',
            nodeId: nodes[1]?.id,
            baseText: nodes[1]?.text,
          },
          { type: 'bind-template', templateId: 'template-1' },
          { type: 'milestone', label: 'proposal-ready' },
        ],
      })
      expect(mapped.isError).not.toBe(true)
      expect(domain.submit.mock.calls[0]?.[0]).toMatchObject({
        mutations: [
          {
            type: 'insert-node',
            text: 'Before the conclusion',
            beforeNodeId: nodes[2]?.id,
            style: 'Body Text',
          },
          {
            type: 'delete-node',
            nodeId: nodes[1]?.id,
            baseText: nodes[1]?.text,
          },
          { type: 'bind-template', templateId: 'template-1' },
          { type: 'milestone', label: 'proposal-ready' },
        ],
      })

      const unanchored = await call(harness.client, 'paperai_commit_document', {
        documentId: document.id,
        message: 'Unanchored operations',
        mutations: [
          { type: 'insert-node', text: 'Append paragraph' },
          { type: 'delete-node', nodeId: nodes[2]?.id },
        ],
      })
      expect(unanchored.isError).not.toBe(true)

      const ambiguous = await call(harness.client, 'paperai_commit_document', {
        documentId: document.id,
        message: 'Invalid insert',
        mutations: [{
          type: 'insert-node',
          text: 'Cannot have two anchors',
          afterNodeId: nodes[0]?.id,
          beforeNodeId: nodes[1]?.id,
        }],
      })
      expect(ambiguous.isError).toBe(true)
      expect(ambiguous.structuredContent?.error).toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      await harness.close()
    }
  })

  it('refuses missing, unconfirmed, and role-incompatible template bindings before commit', async () => {
    const domain = fakeDomain()
    const getContract = vi.mocked(domain.dependencies.templates.getContract)
    getContract
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ ...template, status: 'draft' })
      .mockReturnValueOnce({ ...template, appliesToRoles: ['manuscript'] })
    const harness = await mcpHarness(domain)
    try {
      const missing = await call(harness.client, 'paperai_commit_document', {
        documentId: document.id,
        baseCommitId: document.headCommitId,
        message: 'Bind missing template',
        mutations: [{ type: 'bind-template', templateId: template.id }],
      })
      expect(missing.isError).toBe(true)
      expect(missing.structuredContent?.error).toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
      })

      const draft = await call(harness.client, 'paperai_commit_document', {
        documentId: document.id,
        baseCommitId: document.headCommitId,
        message: 'Bind draft template',
        mutations: [{ type: 'bind-template', templateId: template.id }],
      })
      expect(draft.isError).toBe(true)
      expect(draft.structuredContent?.error).toMatchObject({
        code: 'TEMPLATE_NOT_CONFIRMED',
        details: { templateId: template.id, status: 'draft' },
      })

      const incompatible = await call(harness.client, 'paperai_commit_document', {
        documentId: document.id,
        baseCommitId: document.headCommitId,
        message: 'Bind incompatible template',
        mutations: [{ type: 'bind-template', templateId: template.id }],
      })
      expect(incompatible.isError).toBe(true)
      expect(incompatible.structuredContent?.error).toMatchObject({
        code: 'TEMPLATE_ROLE_INCOMPATIBLE',
        details: {
          templateId: template.id,
          documentRole: 'proposal',
          appliesToRoles: ['manuscript'],
        },
      })
      expect(domain.submit).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it('delegates snapshot restoration and preserves domain error codes', async () => {
    const domain = fakeDomain()
    const harness = await mcpHarness(domain)
    try {
      const reverted = await call(harness.client, 'paperai_revert_document', {
        documentId: document.id,
        baseCommitId: document.headCommitId,
        targetCommitId: 'commit-root',
      })
      expect(reverted.isError).not.toBe(true)
      expect(domain.revert).toHaveBeenCalledWith(expect.objectContaining({
        documentId: document.id,
        baseCommitId: document.headCommitId,
        targetCommitId: DocumentCommitId('commit-root'),
        actor,
      }))

      await call(harness.client, 'paperai_revert_document', {
        documentId: document.id,
        baseCommitId: document.headCommitId,
        targetCommitId: 'commit-root',
        message: 'Restore reviewed version',
      })
      expect(domain.revert).toHaveBeenLastCalledWith(expect.objectContaining({
        message: 'Restore reviewed version',
      }))

      const missing = await call(harness.client, 'paperai_read_document', {
        documentId: 'missing-document',
      })
      expect(missing.isError).toBe(true)
      expect(missing.structuredContent?.error).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
    } finally {
      await harness.close()
    }
  })

  it('prepares draft and formal exports without publishing a file', async () => {
    const domain = fakeDomain(gate('fail'))
    const harness = await mcpHarness(domain)
    try {
      const formal = await call(harness.client, 'paperai_prepare_export', {
        documentId: document.id,
        mode: 'delivery-export',
      })
      expect(formal.structuredContent?.result).toMatchObject({
        allowed: false,
        sourcePath: document.workingPath,
        suggestedFileName: 'proposal.docx',
        headCommitId: document.headCommitId,
        report: { mode: 'delivery-export', status: 'fail' },
      })

      const draft = await call(harness.client, 'paperai_prepare_export', {
        documentId: document.id,
        mode: 'draft-export',
      })
      expect(draft.structuredContent?.result).toMatchObject({
        allowed: true,
        report: { mode: 'draft-export', status: 'fail' },
      })
      const { headCommitId: _headCommitId, ...unbornDocument } = document
      vi.mocked(domain.dependencies.documents.readDocument).mockReturnValueOnce({
        document: unbornDocument,
        nodes,
      })
      const unborn = await call(harness.client, 'paperai_prepare_export', {
        documentId: document.id,
        mode: 'draft-export',
      })
      expect(unborn.structuredContent?.result).toMatchObject({ headCommitId: null })
      expect(domain.check).toHaveBeenCalledTimes(3)
    } finally {
      await harness.close()
    }
  })

  it('shows the publishing tool only for a provider that returns a matching commit', async () => {
    const domain = fakeDomain(gate('fail'))
    const exportDocument = vi.fn<PaperMcpExportAdapter['exportDocument']>(async request => ({
      outputPath: request.destinationPath,
      gate: request.gate,
      commit: commit(request.actor),
    }))
    const harness = await mcpHarness(domain, { exportDocument })
    try {
      const listed = await harness.client.listTools()
      expect(listed.tools.map(tool => tool.name)).toContain('paperai_export_document')

      const blocked = await call(harness.client, 'paperai_export_document', {
        documentId: document.id,
        destinationPath: 'C:\\papers\\thesis\\exports\\delivery\\proposal.docx',
        mode: 'delivery-export',
      })
      expect(blocked.isError).toBe(true)
      expect(blocked.structuredContent?.error).toMatchObject({ code: 'DELIVERY_BLOCKED' })
      expect(exportDocument).not.toHaveBeenCalled()

      const draft = await call(harness.client, 'paperai_export_document', {
        documentId: document.id,
        destinationPath: 'C:\\papers\\thesis\\exports\\drafts\\proposal.docx',
        mode: 'draft-export',
      })
      expect(draft.isError).not.toBe(true)
      expect(exportDocument).toHaveBeenCalledWith(expect.objectContaining({
        document,
        actor,
        mode: 'draft-export',
      }))
      expect(draft.structuredContent?.result).toMatchObject({
        outputPath: 'C:\\papers\\thesis\\exports\\drafts\\proposal.docx',
        commit: { actor },
        provenance: actor,
      })
    } finally {
      await harness.close()
    }
  })

  it('rejects every export commit provenance mismatch', async () => {
    const variants = [
      (value: ReturnType<typeof commit>) => { value.documentId = 'other-document' as never },
      (value: ReturnType<typeof commit>) => { value.actor.kind = 'human' },
      (value: ReturnType<typeof commit>) => { value.actor.name = 'Another Agent' },
      (value: ReturnType<typeof commit>) => { value.actor.client = 'claude' },
      (value: ReturnType<typeof commit>) => { value.actor.provider = 'another-provider' },
      (value: ReturnType<typeof commit>) => { value.actor.model = 'another-model' },
      (value: ReturnType<typeof commit>) => { value.actor.sessionId = 'another-session' },
    ]
    const exportDocument = vi.fn<PaperMcpExportAdapter['exportDocument']>(async (request) => {
      const value = commit(request.actor)
      const mutate = variants[exportDocument.mock.calls.length - 1]
      mutate?.(value)
      return { outputPath: request.destinationPath, gate: request.gate, commit: value }
    })
    const harness = await mcpHarness(fakeDomain(), { exportDocument })
    try {
      for (let index = 0; index < variants.length; index += 1) {
        const result = await call(harness.client, 'paperai_export_document', {
          documentId: document.id,
          destinationPath: `C:\\exports\\variant-${index}.docx`,
          mode: 'draft-export',
        })
        expect(result.isError).toBe(true)
        expect(result.structuredContent?.error).toMatchObject({
          code: 'INVALID_EXPORT_PROVENANCE',
        })
      }
    } finally {
      await harness.close()
    }
  })

  it('normalizes domain failures without exposing stacks', async () => {
    const domain = fakeDomain()
    const list = vi.mocked(domain.dependencies.projects.list)
    const failures: unknown[] = [
      'plain failure',
      null,
      {},
      { code: 7 },
      { code: 'PROJECT_READ_FAILED' },
      new Error('safe message'),
    ]
    for (const problem of failures) list.mockImplementationOnce(() => { throw problem })
    const harness = await mcpHarness(domain)
    try {
      const results: ToolResult[] = []
      for (const _problem of failures) {
        results.push(await call(harness.client, 'paperai_list_projects', {}))
      }
      expect(results.map(result => result.structuredContent?.error?.code)).toEqual([
        'PAPERAI_OPERATION_FAILED',
        'PAPERAI_OPERATION_FAILED',
        'PAPERAI_OPERATION_FAILED',
        'PAPERAI_OPERATION_FAILED',
        'PROJECT_READ_FAILED',
        'PAPERAI_OPERATION_FAILED',
      ])
      expect(results.at(-1)?.structuredContent?.error).toEqual({
        code: 'PAPERAI_OPERATION_FAILED',
        message: 'safe message',
      })
      expect(JSON.stringify(results)).not.toContain('stack')
    } finally {
      await harness.close()
    }
  })

  it('validates direct server-factory bounds', () => {
    const domain = fakeDomain()
    expect(() => createPaperMcpServer(domain.dependencies, actor, {
      defaultNodesPerRead: 1,
      maxNodesPerRead: 0,
      maxMutationsPerCommit: 1,
    })).toThrow(/maxNodesPerRead/)
    expect(() => createPaperMcpServer(domain.dependencies, actor, {
      defaultNodesPerRead: 3,
      maxNodesPerRead: 2,
      maxMutationsPerCommit: 1,
    })).toThrow(/must not exceed/)
  })

  it('returns project and template inventories from the authoritative services', async () => {
    const harness = await mcpHarness()
    try {
      const projects = await call(harness.client, 'paperai_list_projects', {})
      expect(projects.structuredContent?.result).toEqual({ projects: [project] })

      const templates = await call(harness.client, 'paperai_list_templates', {
        projectId: project.id,
      })
      expect(templates.structuredContent?.result).toMatchObject({
        packs: [{ id: 'hit-master' }],
        contracts: [{ id: 'template-1' }],
      })

      const documents = await call(harness.client, 'paperai_list_documents', {
        projectId: project.id,
        role: 'proposal',
      })
      expect(documents.structuredContent?.result).toEqual({ documents: [document] })

      const template = await call(harness.client, 'paperai_get_template', {
        templateId: 'template-1',
      })
      expect(template.structuredContent?.result).toMatchObject({
        template: { id: 'template-1' },
      })
      const missingTemplate = await call(harness.client, 'paperai_get_template', {
        templateId: 'missing-template',
      })
      expect(missingTemplate.structuredContent?.error).toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
      })

      const versions = await call(harness.client, 'paperai_list_versions', {
        documentId: document.id,
      })
      expect(versions.structuredContent?.result).toMatchObject({
        commits: [{ id: 'commit-next' }],
      })

      const checked = await call(harness.client, 'paperai_check_gate', {
        documentId: document.id,
        mode: 'continuous',
      })
      expect(checked.structuredContent?.result).toMatchObject({
        report: { documentId: document.id, mode: 'continuous' },
      })
    } finally {
      await harness.close()
    }
  })
})
