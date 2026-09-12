import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficeCliDocumentEngine, OfficeCliError, officeCliBin } from '../src/index.ts'

interface Reply {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  lossy?: boolean
}

const read = (text: string, lossy = false): SubprocessOutputRead => ({
  text,
  nextOffset: Buffer.byteLength(text),
  lossy,
})

const handle = (reply: Reply): SubprocessHandle => ({
  pid: 101,
  stdin: undefined,
  stdout: undefined,
  stderr: undefined,
  collected: {
    stdout: { readFrom: () => read(reply.stdout ?? '', reply.lossy) },
    stderr: { readFrom: () => read(reply.stderr ?? '') },
  },
  done: Promise.resolve({
    exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
    signal: reply.exitCode === null ? 'SIGTERM' : null,
  }),
  terminate: () => {},
  waitForExit: () => Promise.resolve(true),
})

function fixture(respond: (spec: SubprocessSpawnSpec) => Reply) {
  const ctx = new Context()
  const calls: SubprocessSpawnSpec[] = []
  ctx.provide('subprocess', {
    resolveExecutable: vi.fn(async (command: string) => `C:\\bin\\${command}.exe`),
    spawn: vi.fn((spec: SubprocessSpawnSpec) => {
      calls.push(spec)
      const reply = respond(spec)
      if (spec.argv.includes('raw') && reply.stdout === undefined) {
        return handle({ ...reply, stdout: JSON.stringify({ data:
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
          + '<w:p><w:r><w:t>original</w:t></w:r></w:p><w:p><w:r><w:t>original</w:t></w:r></w:p></w:body></w:document>',
        }) })
      }
      return handle(spec.argv.includes('get') && reply.stdout === undefined
        ? { ...reply, stdout: JSON.stringify({ data: { type: 'paragraph', text: 'original', childCount: 0, children: [] } }) }
        : reply)
    }),
  } as never)
  const engine = new OfficeCliDocumentEngine(ctx, {
    command: 'officecli',
    timeoutMs: 10_000,
    outputMaxBytes: 1_000_000,
    terminateGraceMs: 1_000,
  })
  return { ctx, calls, engine }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OfficeCliDocumentEngine', () => {
  it('reports health through the managed subprocess seam', async () => {
    const ready = fixture(() => ({ stdout: 'officecli 1.0.145\n' }))
    await expect(ready.engine.health()).resolves.toMatchObject({ status: 'ready', version: '1.0.145' })
    expect(ready.calls[0]?.argv).toEqual(['C:\\bin\\officecli.exe', '--version'])
    expect(ready.calls[0]?.env).toMatchObject({
      OFFICECLI_SKIP_UPDATE: '1',
      OFFICECLI_RESIDENT_FLUSH: 'each',
    })

    const unavailable = fixture(() => ({ stderr: 'native load failed', exitCode: 1 }))
    await expect(unavailable.engine.health()).resolves.toEqual({
      status: 'unavailable',
      detail: 'native load failed',
    })
  })

  it('parses nested Office paths and leaves the resident document running', async () => {
    const { calls, engine } = fixture(spec => spec.argv.includes('text')
      ? { stdout: '[/document/body/p[1]] 第一段\n[/document/body/tbl[1]/tr[1]/tc[1]/p[1]] 单元格\nnoise' }
      : {})
    await expect(engine.readTextNodes('D:\\paper.docx')).resolves.toEqual([
      { officePath: '/document/body/p[1]', text: '第一段', kind: 'paragraph' },
      { officePath: '/document/body/tbl[1]/tr[1]/tc[1]/p[1]', text: '单元格', kind: 'table' },
    ])
    expect(calls.map(call => call.argv.slice(1, 3))).toEqual([['view', 'D:\\paper.docx']])
  })

  it('ignores malformed text records and classifies non-paragraph nodes', async () => {
    const { engine } = fixture(spec => spec.argv.includes('text')
      ? { stdout: '[bad] ignored\n[/document/body/sdt[1]] field\n[/unterminated\n' }
      : {})
    await expect(engine.readTextNodes('paper.docx')).resolves.toEqual([
      { officePath: '/document/body/sdt[1]', text: 'field', kind: 'unknown' },
    ])
  })

  it('applies one ordered mutation batch and saves once', async () => {
    const { calls, engine } = fixture(() => ({}))
    await engine.applyMutations('D:\\paper.docx', [
      { type: 'replace-text', officePath: '/document/body/p[1]', text: '新文本' },
      { type: 'insert-paragraph', text: '新增', style: 'Heading 1', after: '/document/body/p[1]' },
      { type: 'remove', officePath: '/document/body/p[3]' },
    ])
    expect(calls.map(call => call.argv.slice(1))).toEqual([
      ['get', 'D:\\paper.docx', '/document/body/p[1]', '--depth', '3', '--json'],
      ['raw', 'D:\\paper.docx', '/document', '--json'],
      ['set', 'D:\\paper.docx', '/document/body/p[1]', '--prop', 'text=新文本', '--json'],
      ['add', 'D:\\paper.docx', '/body', '--type', 'paragraph', '--prop', 'text=新增', '--prop', 'style=Heading 1', '--after', '/document/body/p[1]', '--json'],
      ['remove', 'D:\\paper.docx', '/document/body/p[3]', '--json'],
      ['save', 'D:\\paper.docx', '--json'],
    ])
  })

  it('rebuilds a paragraph from its runs in one batch and leaves plain text one command', async () => {
    const { calls, engine } = fixture(() => ({}))
    await engine.applyMutations('D:\\paper.docx', [
      { type: 'replace-text', officePath: '/body/p[1]', text: '普通' },
      {
        type: 'replace-text',
        officePath: '/body/p[2]',
        text: '加粗其余',
        runs: [{ text: '加粗', bold: true, size: '16pt' }, { text: '其余' }],
      },
    ])
    const [plain, formatted] = calls.filter(call => !call.argv.includes('get') && !call.argv.includes('raw')).map(call => call.argv.slice(1))
    expect(plain).toEqual(['set', 'D:\\paper.docx', '/body/p[1]', '--prop', 'text=普通', '--json'])
    expect(formatted?.slice(0, 3)).toEqual(['batch', 'D:\\paper.docx', '--commands'])
    expect(JSON.parse(String(formatted?.[3]))).toEqual([
      { command: 'set', path: '/body/p[2]', props: { text: '加粗' } },
      { command: 'set', path: '/body/p[2]/r[1]', props: { bold: 'true', size: '16pt', 'size.cs': '16pt' } },
      { command: 'add', parent: '/body/p[2]', type: 'run', props: { text: '其余' } },
    ])
  })

  it('keeps soft breaks in the first run and encodes later run breaks for OfficeCLI add', async () => {
    const { calls, engine } = fixture(() => ({}))
    await engine.applyMutations('D:\\paper.docx', [{
      type: 'replace-text', officePath: '/body/p[1]', text: 'first\vnextlast\vline',
      runs: [{ text: 'first\vnext', bold: true }, { text: 'last\vline', italic: true }],
    }])
    const batch = calls.find(call => call.argv.includes('batch'))!
    expect(JSON.parse(String(batch.argv[batch.argv.indexOf('--commands') + 1]))).toEqual([
      { command: 'set', path: '/body/p[1]', props: { text: 'first\vnext' } },
      { command: 'set', path: '/body/p[1]/r[1]', props: { bold: 'true' } },
      { command: 'add', parent: '/body/p[1]', type: 'run', props: { text: 'last\nline', italic: 'true' } },
    ])
  })

  it('splits a paragraph beside its original anchor and preserves layout on new paragraphs', async () => {
    const { calls, engine } = fixture((spec) => {
      if (spec.argv.includes('get')) return { stdout: JSON.stringify({ data: {
        type: 'paragraph', text: 'original', childCount: 1,
        format: { style: 'Normal', align: 'left', indent: '12pt', lineSpacing: '1.5x' },
        children: [{ type: 'run', childCount: 0 }],
      } }) }
      if (spec.argv.includes('add')) return { stdout: JSON.stringify({ data: 'Added paragraph at /body/p[@paraId=NEW]' }) }
      return {}
    })
    await engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[2]', text: 'one\ntwo', paragraphs: [
      { text: 'one', runs: [{ text: 'one', font: 'Arial' }], format: { align: 'center' } },
      { text: 'two', runs: [{ text: 'two', underline: false }], format: { indent: '24pt' } },
    ] }])
    const batches = calls.filter(call => call.argv.includes('batch')).map(call => JSON.parse(String(call.argv[4])) as unknown)
    expect(batches[0]).toEqual([
      { command: 'set', path: '/body/p[2]', props: { align: 'center' } },
      { command: 'set', path: '/body/p[2]', props: { text: 'one' } },
      { command: 'set', path: '/body/p[2]/r[1]', props: { font: 'Arial' } },
    ])
    expect(calls.find(call => call.argv.includes('add'))?.argv).toEqual([
      'C:\\bin\\officecli.exe', 'add', 'paper.docx', '/body', '--type', 'paragraph', '--after', '/body/p[2]',
      '--prop', 'style=Normal', '--prop', 'align=left', '--prop', 'indent=24pt', '--prop', 'lineSpacing=1.5x', '--prop', 'text=two', '--json',
    ])
    expect(batches[1]).toContainEqual({ command: 'set', path: '/body/p[@paraId=NEW]/r[1]', props: { underline: 'none' } })
    expect(calls.at(-1)?.argv).toEqual(['C:\\bin\\officecli.exe', 'save', 'paper.docx', '--json'])
  })

  it('changes paragraph layout without replacing its unchanged text', async () => {
    const { calls, engine } = fixture(() => ({}))
    await engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'original',
      paragraphs: [{ text: 'original', format: { style: 'Heading1', lineSpacing: '2x' } }],
    }])
    expect(JSON.parse(String(calls.find(call => call.argv.includes('batch'))?.argv[4]))).toEqual([
      { command: 'set', path: '/body/p[1]', props: { style: 'Heading1', lineSpacing: '2x' } },
    ])
  })

  it.each([
    { type: 'paragraph', childCount: 1, children: [{ type: 'math', childCount: 0 }] },
    { type: 'paragraph', childCount: 1, children: [{ type: 'run', childCount: 1 }] },
    { type: 'paragraph', childCount: 2, children: [{ type: 'run', childCount: 0 }] },
    { matches: 0, results: [] },
  ])('refuses paragraph replacement when its content cannot be reconstructed: %j', async (data) => {
    const { calls, engine } = fixture(() => ({ stdout: JSON.stringify({ data }) }))
    await expect(engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(calls.map(call => call.argv[1])).toEqual(['get'])
  })

  it('refuses to continue after an insertion with no returned paragraph identity', async () => {
    const { engine } = fixture(() => ({}))
    await expect(engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'original\nnew',
      paragraphs: [{ text: 'original' }, { text: 'new' }],
    }])).rejects.toThrow()
  })

  it.each([
    '<x:br x:type="page"/>', '<x:br x:type="column"/>', '<x:br x:clear="all"/>',
    '<x:sym x:font="Symbol" x:char="F041"/>', '<x:softHyphen/>', '<x:instrText>PAGE</x:instrText>',
    '<x:fldChar x:fldCharType="begin"/>', '<x:footnoteReference x:id="1"/>', '<x:lastRenderedPageBreak/>',
  ])('protects inline XML omitted from the OfficeCLI run projection: %s', async (inline) => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:id="http://schemas.microsoft.com/office/word/2010/wordml"><x:body><x:p id:paraId="AABB0011">'
      + `<x:r><x:t>before</x:t>${inline}<x:t>after</x:t></x:r></x:p></x:body></x:document>`,
    }) } : {})
    await expect(engine.applyMutations('paper.docx', [{
      type: 'replace-text', officePath: '/body/p[@paraId=AABB0011]', text: 'edited',
    }])).rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw'])
  })

  it('accepts projected line breaks and tabs at a nested table paragraph', async () => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>before</w:t><w:br/><w:tab/><w:t>after</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '</w:body></w:document>',
    }) } : {})
    await engine.applyMutations('paper.docx', [{
      type: 'replace-text', officePath: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'edited',
    }])
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw', 'set', 'save'])
  })

  it.each(['vertAlign', 'strike', 'dstrike', 'vanish', 'rStyle', 'rPrChange', 'lang', 'rtl'])
  ('protects run properties absent from editable text runs: %s', async (property) => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
      + `<w:r><w:rPr><w:${property} w:val="subscript"/></w:rPr><w:t>original</w:t></w:r></w:p></w:body></w:document>`,
    }) } : {})
    await expect(engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw'])
  })

  it.each(['b', 'i'])('protects independent complex-script emphasis: %s', async (property) => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
      + '<w:r><w:t>First </w:t></w:r><w:r><w:rPr>'
      + `<w:${property} w:val="0"/><w:${property}Cs/></w:rPr><w:t>العربية</w:t></w:r></w:p></w:body></w:document>`,
    }) } : {})
    await expect(engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'First edited',
      runs: [{ text: 'First ' }, { text: 'edited' }],
    }])).rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw'])
  })

  it.each(['w:val="double"', 'w:val="wave"', 'w:val="single" w:color="FF0000"', 'w:themeColor="accent1"', 'color="FF0000"'])
  ('protects underline details absent from the boolean edit value: %s', async (attributes) => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
      + `<w:r><w:rPr><w:u ${attributes}/></w:rPr><w:t>original</w:t></w:r></w:p></w:body></w:document>`,
    }) } : {})
    await expect(engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw'])
  })

  it.each(['', 'w:val="single"', 'w:val="none"'])('accepts boolean underline declarations: %s', async (attributes) => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
      + `<w:r><w:rPr><w:u ${attributes}/></w:rPr><w:t>original</w:t></w:r></w:p></w:body></w:document>`,
    }) } : {})
    await engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }])
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw', 'set', 'save'])
  })

  it.each([
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"/>',
    '<w:rFonts w:asciiTheme="minorHAnsi"/>', '<w:sz w:val="24"/><w:szCs w:val="40"/>',
    '<w:szCs w:val="40"/>', '<w:color w:val="4472C4" w:themeColor="accent1"/>',
  ])('protects character detail that one font, size, or RGB value cannot represent: %s', async (properties) => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
      + `<w:r><w:rPr>${properties}</w:rPr><w:t>original</w:t></w:r></w:p></w:body></w:document>`,
    }) } : {})
    await expect(engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw'])
  })

  it('accepts matching script fonts and sizes with a plain RGB color', async () => {
    const { engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data:
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
      + '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial"/>'
      + '<w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="4472C4"/></w:rPr>'
      + '<w:t>original</w:t></w:r></w:p></w:body></w:document>',
    }) } : {})
    await engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }])
  })

  it.each(['<broken>', '', null])('rejects unavailable or malformed raw XML before writing: %j', async (data) => {
    const { calls, engine } = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data }) } : {})
    await expect(engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow()
    expect(calls.map(call => call.argv[1])).toEqual(['get', 'raw'])
  })

  it('inherits paragraph character defaults on inserted paragraphs while run overrides remain explicit', async () => {
    const { calls, engine } = fixture((spec) => {
      if (spec.argv.includes('get')) return { stdout: JSON.stringify({ data: {
        type: 'paragraph', text: 'original', childCount: 0, children: [],
        format: { 'font.latin': 'Arial', 'font.ea': 'Arial', size: '20pt', 'size.cs': '20pt', bold: true },
      } }) }
      if (spec.argv.includes('add')) return { stdout: JSON.stringify({ data: 'Added paragraph at /body/p[@paraId=NEW]' }) }
      return {}
    })
    await engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'original\nnew',
      paragraphs: [{ text: 'original' }, { text: 'new', runs: [{ text: 'new', bold: false, font: '' }] }],
    }])
    const add = calls.find(call => call.argv.includes('add'))!.argv
    expect(add).toEqual(expect.arrayContaining(['font.latin=Arial', 'font.ea=Arial', 'size=20pt', 'size.cs=20pt', 'bold=true']))
    const batch = JSON.parse(String(calls.find(call => call.argv.includes('batch'))!.argv[4])) as unknown
    expect(batch).toEqual([
      { command: 'set', path: '/body/p[@paraId=NEW]', props: { text: 'new' } },
      { command: 'set', path: '/body/p[@paraId=NEW]/r[1]', props: { bold: 'false', font: '' } },
    ])
  })

  it('parses preview, inspection, and validation envelopes', async () => {
    const { engine } = fixture((spec) => {
      if (spec.argv.includes('html')) return { stdout: '<article>论文</article>' }
      if (spec.argv.includes('get')) return { stdout: '{"data":{"style":"正文"}}' }
      if (spec.argv.includes('validate')) return { stdout: '{"data":{"success":true,"issues":[]}}' }
      return {}
    })
    await expect(engine.previewHtml('paper.docx')).resolves.toBe('<article>论文</article>')
    await expect(engine.inspect('paper.docx', '/document/body/p[1]', 3)).resolves.toEqual({ style: '正文' })
    await expect(engine.validate('paper.docx')).resolves.toEqual({
      success: true,
      details: { success: true, issues: [] },
    })
  })

  it('uses validation exit status when no declared success exists', async () => {
    const empty = fixture(spec => spec.argv.includes('validate') ? { stderr: 'invalid', exitCode: 1 } : {})
    await expect(empty.engine.validate('paper.docx')).resolves.toEqual({
      success: false,
      details: { stderr: 'invalid' },
    })
    const primitiveData = fixture(spec => spec.argv.includes('get') ? { stdout: '{"data":null,"success":true}' } : {})
    await expect(primitiveData.engine.inspect('paper.docx', '/document')).resolves.toEqual({ data: null, success: true })
  })

  it('fails explicitly on truncated or malformed engine output', async () => {
    const truncated = fixture(spec => spec.argv.includes('html')
      ? { stdout: '<article>', lossy: true }
      : {})
    await expect(truncated.engine.previewHtml('paper.docx')).rejects.toThrow(OfficeCliError)

    const malformed = fixture(spec => spec.argv.includes('get')
      ? { stdout: 'not json' }
      : {})
    await expect(malformed.engine.inspect('paper.docx', '/document/body/p[1]')).rejects
      .toThrow('OfficeCLI returned invalid JSON')
  })

  it('rejects invalid deployment limits before publishing a usable Provider', () => {
    const ctx = new Context()
    expect(() => new OfficeCliDocumentEngine(ctx, {
      command: 'officecli',
      timeoutMs: 0,
      outputMaxBytes: 1,
      terminateGraceMs: 1,
    })).toThrow('timeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { timeoutMs: Number.NaN })).toThrow('timeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { cleanupTimeoutMs: 0 }))
      .toThrow('cleanupTimeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { residentIdleMs: 0 }))
      .toThrow('residentIdleMs must be a positive safe integer')
  })

  it('resolves every supported OfficeCLI manifest bin form', () => {
    expect(officeCliBin({ bin: 'cli.js' })).toBe('cli.js')
    expect(officeCliBin({ bin: { officecli: 'bin/officecli.js' } })).toBe('bin/officecli.js')
    expect(() => officeCliBin({ bin: {} })).toThrow('declares no officecli binary')
  })

  it('normalizes legacy converter configuration through Schemastery', () => {
    expect(OfficeCliDocumentEngine.Config({})).toMatchObject({
      cleanupTimeoutMs: 5_000,
      legacyDocTimeoutMs: 120_000,
      legacyDocOutputMaxBytes: 1024 * 1024,
      legacyDocTerminateGraceMs: 5_000,
    })
    expect(OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: false }).legacyDocPowerShellCommand).toBe(false)
    expect(OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: 'pwsh.exe' }).legacyDocPowerShellCommand).toBe('pwsh.exe')
    expect(() => OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: 7 } as never)).toThrow()
  })

  it('uses the packaged launcher and caches executable resolution', async () => {
    const ctx = new Context()
    const calls: SubprocessSpawnSpec[] = []
    const resolveExecutable = vi.fn(async (command: string) => command)
    ctx.provide('subprocess', {
      resolveExecutable,
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push(spec)
        return handle({ stdout: 'officecli\n' })
      },
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, {})
    await engine.health()
    await engine.health()
    expect(resolveExecutable).toHaveBeenCalledTimes(1)
    expect(calls[0]?.argv[0]).toBe(process.execPath)
    expect(calls[0]?.argv[1]).toMatch(/officecli/u)
  })

  it('projects the host legacy-conversion capability through the structural engine extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-officecli-method-'))
    const source = join(root, 'source.doc')
    const target = join(root, 'target.docx')
    await writeFile(source, 'source')
    try {
      const { calls, engine } = fixture((spec) => {
        if (spec.argv.some(argument => argument.endsWith('convert-legacy-doc.ps1'))) writeFileSync(target, 'docx')
        return {}
      })
      const result = await engine.normalizeLegacyDocument(source, target)
      await expect(readFile(source, 'utf8')).resolves.toBe('source')
      if (process.platform === 'win32') {
        expect(result).toEqual({ status: 'normalized' })
        expect(calls.at(-1)?.argv).toContain(target)
      } else {
        expect(result).toEqual({
          status: 'degraded',
          detail: `Legacy .doc conversion requires Windows and Microsoft Word; current platform is ${process.platform}`,
        })
        expect(calls).toHaveLength(0)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports empty health output and thrown non-Error diagnostics', async () => {
    const empty = fixture(() => ({ stdout: '   ' }))
    await expect(empty.engine.health()).resolves.toMatchObject({ status: 'ready' })
    const failed = fixture(() => ({ stderr: '', exitCode: 5 }))
    await expect(failed.engine.health()).resolves.toEqual({
      status: 'unavailable',
      detail: 'OfficeCLI returned a non-zero status',
    })

    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw 'resolution failed' },
      spawn: vi.fn(),
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, {})
    await expect(engine.health()).resolves.toEqual({ status: 'unavailable', detail: 'resolution failed' })

    const errorCtx = new Context()
    errorCtx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('executable lookup failed') },
      spawn: vi.fn(),
    } as never)
    const errorEngine = new OfficeCliDocumentEngine(errorCtx, {})
    await expect(errorEngine.health()).resolves.toEqual({ status: 'unavailable', detail: 'executable lookup failed' })
  })

  it('applies optional insertion positions independently', async () => {
    const { calls, engine } = fixture(() => ({}))
    await engine.applyMutations('paper.docx', [
      { type: 'insert-paragraph', text: 'positioned', before: '/document/body/p[2]', index: 1 },
    ])
    expect(calls[0]?.argv).toEqual([
      'C:\\bin\\officecli.exe',
      'add',
      'paper.docx',
      '/body',
      '--type',
      'paragraph',
      '--prop',
      'text=positioned',
      '--before',
      '/document/body/p[2]',
      '--index',
      '1',
      '--json',
    ])
  })

  it('classifies OfficeCLI cancellation, timeout, and non-zero failures', async () => {
    const cancellation = new AbortController()
    const cancelledCtx = new Context()
    cancelledCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (_spec: SubprocessSpawnSpec) => {
        cancellation.abort()
        return handle({ exitCode: null })
      },
    } as never)
    const cancelled = new OfficeCliDocumentEngine(cancelledCtx, { command: 'officecli' })
    await expect(cancelled.previewHtml('paper.docx', cancellation.signal)).rejects.toThrow('cancelled')

    const timeoutCtx = new Context()
    timeoutCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => spec.argv.includes('close')
        ? handle({})
        : {
          ...handle({}),
          done: new Promise(resolveDone => spec.signal?.addEventListener('abort', () => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })),
        },
    } as never)
    const timedOut = new OfficeCliDocumentEngine(timeoutCtx, { command: 'officecli', timeoutMs: 1 })
    await expect(timedOut.previewHtml('paper.docx')).rejects.toThrow('timed out')

    for (const stderr of ['failed explicitly', '']) {
      const failed = fixture(spec => spec.argv.includes('html') ? { exitCode: 3, stderr } : {})
      await expect(failed.engine.previewHtml('paper.docx')).rejects.toThrow(
        stderr === '' ? 'exit code 3' : stderr,
      )
    }
  })

  it('releases a cancelled document with a fresh bounded close signal', async () => {
    const operations = [
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) =>
        engine.inspect('paper.docx', '/document/body/p[1]', 2, signal),
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) =>
        engine.applyMutations('paper.docx', [
          { type: 'replace-text', officePath: '/document/body/p[1]', text: 'changed' },
        ], signal),
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) => engine.validate('paper.docx', signal),
    ]

    for (const operation of operations) {
      const controller = new AbortController()
      const calls: SubprocessSpawnSpec[] = []
      let cleanupSignal: AbortSignal | undefined
      const ctx = new Context()
      ctx.provide('subprocess', {
        resolveExecutable: async (command: string) => command,
        spawn: (spec: SubprocessSpawnSpec) => {
          calls.push(spec)
          if (spec.argv.includes('close')) {
            cleanupSignal = spec.signal
            return handle({})
          }
          controller.abort(new Error('caller cancelled'))
          return handle({ exitCode: null })
        },
      } as never)
      const engine = new OfficeCliDocumentEngine(ctx, {
        command: 'officecli',
        cleanupTimeoutMs: 25,
      })

      await expect(operation(engine, controller.signal)).rejects.toThrow('cancelled')
      await engine.release('paper.docx')
      expect(calls.at(-1)?.argv).toContain('close')
      expect(cleanupSignal).toBeDefined()
      expect(cleanupSignal).not.toBe(controller.signal)
      expect(cleanupSignal?.aborted).toBe(false)
    }
  })

  it('bounds independent close cleanup without replacing the caller cancellation', async () => {
    const controller = new AbortController()
    let cleanupSignal: AbortSignal | undefined
    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => {
        if (!spec.argv.includes('close')) {
          controller.abort(new Error('caller cancelled'))
          return handle({ exitCode: null })
        }
        cleanupSignal = spec.signal
        return {
          ...handle({}),
          done: new Promise(resolveDone => spec.signal?.addEventListener('abort', () => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })),
        }
      },
    } as never)
    const warning = vi.spyOn(ctx.logger, 'warn')
    const engine = new OfficeCliDocumentEngine(ctx, {
      command: 'officecli',
      cleanupTimeoutMs: 1,
    })

    await expect(engine.inspect('paper.docx', '/document', 1, controller.signal))
      .rejects.toThrow('cancelled')
    await engine.release('paper.docx')
    expect(cleanupSignal?.aborted).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out after 1 ms'))
  })

  it('handles absent readers, stderr truncation, and close failures', async () => {
    const noReadersCtx = new Context()
    noReadersCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: () => ({ ...handle({}), collected: {} }),
    } as never)
    const noReaders = new OfficeCliDocumentEngine(noReadersCtx, { command: 'officecli' })
    await expect(noReaders.previewHtml('paper.docx')).resolves.toBe('')

    const stderrLossyCtx = new Context()
    stderrLossyCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: () => ({
        ...handle({}),
        collected: {
          stdout: { readFrom: () => read('') },
          stderr: { readFrom: () => read('truncated', true) },
        },
      }),
    } as never)
    const stderrLossy = new OfficeCliDocumentEngine(stderrLossyCtx, { command: 'officecli' })
    await expect(stderrLossy.previewHtml('paper.docx')).rejects.toThrow('output exceeded')

    const closeFailure = fixture(spec => spec.argv.includes('close') ? { lossy: true } : { stdout: '<p />' })
    const warning = vi.spyOn(closeFailure.ctx.logger, 'warn')
    await expect(closeFailure.engine.previewHtml('paper.docx')).resolves.toBe('<p />')
    await closeFailure.engine.release('paper.docx')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not close'))
  })

  it('closes an idle resident after residentIdleMs and never twice for one release', async () => {
    vi.useFakeTimers()
    try {
      const { calls, engine } = fixture(() => ({ stdout: '<p />' }))
      await engine.previewHtml('paper.docx')
      expect(calls.map(call => call.argv[1])).toEqual(['view'])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls.map(call => call.argv[1])).toEqual(['view', 'close'])
      await engine.previewHtml('paper.docx')
      await engine.release('paper.docx')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls.map(call => call.argv[1])).toEqual(['view', 'close', 'view', 'close'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('release without a resident issues no close', async () => {
    const { calls, engine } = fixture(() => ({ stdout: '<p />' }))
    await engine.release('paper.docx')
    expect(calls).toEqual([])
    await engine.previewHtml('paper.docx')
    await engine.release('paper.docx')
    await engine.release('paper.docx')
    expect(calls.map(call => call.argv[1])).toEqual(['view', 'close'])
  })

  it('serializes overlapping operations and releases only the current lease tail', async () => {
    const ctx = new Context()
    let releaseFirst: (() => void) | undefined
    let viewCount = 0
    const calls: string[][] = []
    ctx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push([...spec.argv])
        if (spec.argv.includes('html') && viewCount++ === 0) {
          return {
            ...handle({ stdout: 'first' }),
            done: new Promise((resolveDone) => {
              releaseFirst = () => { resolveDone({ exitCode: 0, signal: null }) }
            }),
          }
        }
        return handle({ stdout: spec.argv.includes('html') ? 'second' : '' })
      },
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, { command: 'officecli' })
    const first = engine.previewHtml('same.docx')
    const second = engine.previewHtml('same.docx')
    await vi.waitFor(() => { expect(releaseFirst).toBeTypeOf('function') })
    expect(calls.filter(argv => argv.includes('html'))).toHaveLength(1)
    releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })
})
