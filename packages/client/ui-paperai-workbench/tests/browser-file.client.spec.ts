// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isWordFile, readWordFileBase64, wordStem,
} from '../src/client/browser-file.ts'

interface FakeReader {
  result: string | ArrayBuffer | null
  error: DOMException | null
  onerror: (() => void) | null
  onload: (() => void) | null
}

function stubReader(run: (reader: FakeReader) => void): void {
  class Reader implements FakeReader {
    result: string | ArrayBuffer | null = null
    error: DOMException | null = null
    onerror: (() => void) | null = null
    onload: (() => void) | null = null

    readAsArrayBuffer(): void {
      run(this)
    }
  }
  vi.stubGlobal('FileReader', Reader)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('browser Word-file helpers', () => {
  it('accepts only bounded non-empty Word files', () => {
    expect(isWordFile({ name: 'proposal.docx', size: 1 })).toBe(true)
    expect(isWordFile({ name: 'legacy.DOC', size: 1 })).toBe(true)
    expect(isWordFile({ name: 'empty.docx', size: 0 })).toBe(false)
    expect(isWordFile({ name: 'too-large.docx', size: 32 * 1024 * 1024 + 1 })).toBe(false)
    expect(isWordFile({ name: 'notes.txt', size: 1 })).toBe(false)
  })

  it('reads the canonical base64 suffix and derives a display name', async () => {
    const file = new File(['word'], 'proposal.docx', { type: 'application/zip' })
    await expect(readWordFileBase64(file)).resolves.toBe('d29yZA==')
    expect(wordStem(file.name)).toBe('proposal')
    expect(wordStem('.docx')).toBe('.docx')
  })

  it('rejects unsupported inputs before starting FileReader', async () => {
    await expect(readWordFileBase64(new File([], 'empty.docx')))
      .rejects.toThrow('Select a non-empty .doc or .docx file no larger than 32 MB.')
  })

  it('preserves a FileReader error', async () => {
    stubReader((reader) => {
      reader.error = new DOMException('read failed')
      reader.onerror?.()
    })
    await expect(readWordFileBase64(new File(['word'], 'proposal.docx')))
      .rejects.toThrow('read failed')
  })

  it('supplies a diagnostic when FileReader fails without an error value', async () => {
    stubReader((reader) => { reader.onerror?.() })
    await expect(readWordFileBase64(new File(['word'], 'proposal.docx')))
      .rejects.toThrow('The selected file could not be read.')
  })

  it('rejects a non-binary FileReader result', async () => {
    stubReader((reader) => {
      reader.result = 'not-binary'
      reader.onload?.()
    })
    await expect(readWordFileBase64(new File(['word'], 'proposal.docx')))
      .rejects.toThrow('The selected file did not produce browser binary data.')
  })
})
