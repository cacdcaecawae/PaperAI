import { describe, expect, it } from 'vitest'
import { selectionSource, wordSelectionReference } from '../src/client/selection-context.ts'
import { documentSnapshot, NODE_PARAGRAPH, COMMIT_1 } from './fixtures.client.ts'

describe('Word selection context', () => {
  it('freezes exact text, version and block provenance before the composer serializes it', async () => {
    const document = { ...documentSnapshot() }
    const excerpt = { nodeIds: [NODE_PARAGRAPH], text: 'Selected\n文字 "quoted"' }
    const reference = wordSelectionReference(document, excerpt)
    excerpt.text = 'another selection'
    document.path = 'another.docx'
    const text = await selectionSource().codec!.serialize(reference.ref, new AbortController().signal)
    expect(text).toBe(reference.clipboardText)
    const context = JSON.parse(text.split('[Word selection]\n')[1]!.split('\n')[0]!) as Record<string, unknown>
    expect(context).toMatchObject({ version: COMMIT_1, blocks: [NODE_PARAGRAPH], text: 'Selected\n文字 "quoted"' })
    expect(context.path).not.toBe(document.path)
  })
})
