import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DocumentCommitId,
  type DocumentCommit,
} from '@paperai/domain'
import { createPaperMcpServer } from '@paperai/mcp/server'
import type {
  PaperMcpAgentIdentity,
  PaperMcpDependencies,
} from '@paperai/mcp'
import { agentActor, exportHarness, report, type ExportHarness } from './helpers.ts'

const harnesses: ExportHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()))
})

describe('PaperAI export composition', () => {
  it('executes paperai_export_document only while the Cordis adapter is registered', async () => {
    const harness = await exportHarness()
    harnesses.push(harness)
    const actor = agentActor as PaperMcpAgentIdentity
    const commit: DocumentCommit = {
      id: DocumentCommitId('commit-head'),
      documentId: harness.document.id,
      message: 'head',
      actor,
      snapshotPath: harness.snapshotPath,
      documentSha256: harness.document.sourceSha256,
      gate: report(harness.document.id, 'continuous'),
      operations: [],
      createdAt: harness.document.createdAt,
    }
    const project = {
      id: harness.document.projectId,
      workspaceId: 'workspace-export',
      name: 'export',
      rootPath: harness.root,
      createdAt: harness.document.createdAt,
      updatedAt: harness.document.updatedAt,
    }
    const scope = { workspaceRoot: harness.root, sandboxMode: () => 'workspace-write' as const }
    const dependencies: PaperMcpDependencies = {
      projects: {
        get: vi.fn(() => project),
        list: vi.fn(() => [project]),
        resolveForPath: vi.fn(() => Promise.resolve(project)),
      },
      documents: {
        listDocuments: vi.fn(() => [harness.document]),
        readDocument: vi.fn(() => ({ document: harness.document, nodes: [] })),
      },
      templates: {
        check: vi.fn(async ({ mode }: { mode: Parameters<typeof report>[1] }) => (
          report(harness.document.id, mode)
        )),
        getContract: vi.fn(),
        listContracts: vi.fn(() => []),
        listPacks: vi.fn(() => []),
      },
      commits: {
        listHistory: vi.fn(() => [commit]),
        submit: vi.fn(),
        revert: vi.fn(),
      },
    }
    const server = createPaperMcpServer(dependencies, actor, scope, {
      defaultNodesPerRead: 10,
      maxNodesPerRead: 20,
      maxMutationsPerCommit: 8,
    }, harness.adapter())
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'paperai-export-composition', version: '1' })
    await client.connect(clientTransport)
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name)
      expect(names).toContain('paperai_export_document')
      const outputPath = join(harness.root, 'mcp-export.docx')
      const result = await client.callTool({
        name: 'paperai_export_document',
        arguments: {
          documentId: harness.document.id,
          destinationPath: outputPath,
          mode: 'draft-export',
        },
      })
      const canonicalOutputPath = await realpath(outputPath)
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        result: {
          outputPath: canonicalOutputPath,
          gate: { mode: 'draft-export' },
          commit: { actor },
          provenance: actor,
        },
      })
      expect(await readFile(outputPath)).toEqual(Buffer.from(harness.snapshotBytes))
    } finally {
      await client.close()
      await server.close()
    }

    await harness.ctx.fiber.dispose()
    expect(harness.adapter()).toBeUndefined()

    const after = createPaperMcpServer(dependencies, actor, scope, {
      defaultNodesPerRead: 10,
      maxNodesPerRead: 20,
      maxMutationsPerCommit: 8,
    })
    const [afterClientTransport, afterServerTransport] = InMemoryTransport.createLinkedPair()
    await after.connect(afterServerTransport)
    const afterClient = new Client({ name: 'paperai-export-after-dispose', version: '1' })
    await afterClient.connect(afterClientTransport)
    try {
      expect((await afterClient.listTools()).tools.map(tool => tool.name))
        .not.toContain('paperai_export_document')
    } finally {
      await afterClient.close()
      await after.close()
    }
  })
})
