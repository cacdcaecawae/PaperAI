/** Opt-in native OfficeCLI 1.0.145 readbacks; the default unit lane never downloads or starts the binary. */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { DOMParser, XMLSerializer, onWarningStopParsing } from '@xmldom/xmldom'
import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OfficeCliDocumentEngine } from '../src/index.ts'

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const WORD_ID = 'http://schemas.microsoft.com/office/word/2010/wordml'
const XMLNS = 'http://www.w3.org/2000/xmlns/'
const proposal = fileURLToPath(new URL('../../template-pack-hit/assets/proposal.docx', import.meta.url))
const command = process.env.DSH_PAPERAI_OFFICECLI_COMMAND

type Canonical = string | readonly [string | null, string | null, readonly string[][], readonly Canonical[]]

function children(node: XmlNode): XmlElement[] {
  return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === child.ELEMENT_NODE)
}

function canonical(node: XmlNode): Canonical {
  if (node.nodeType !== node.ELEMENT_NODE) return node.textContent ?? ''
  const element = node as XmlElement
  return [element.namespaceURI, element.localName,
    Array.from(element.attributes)
      // OfficeCLI refreshes Word's text cache id after a text change; namespace declaration order is serialization.
      .filter(attribute => attribute.namespaceURI !== XMLNS && !(attribute.namespaceURI === WORD_ID && attribute.localName === 'textId'))
      .map(attribute => [attribute.namespaceURI ?? '', attribute.localName ?? '', attribute.value]).sort(),
    Array.from(element.childNodes)
      .filter(child => child.nodeType === child.ELEMENT_NODE || child.nodeType === child.TEXT_NODE).map(canonical),
  ]
}

function paragraphs(document: XmlDocument): XmlElement[] {
  return children(document.getElementsByTagNameNS(WORD, 'body')[0]!).filter(element => element.namespaceURI === WORD && element.localName === 'p')
}

function textRuns(paragraph: XmlElement): { text: string; properties: Canonical | null }[] {
  return children(paragraph).filter(element => element.localName === 'r').map(run => ({
    text: children(run).map(element => element.localName === 't' ? element.textContent ?? ''
      : element.localName === 'tab' ? '\t'
        : element.localName === 'br' && ['', 'textWrapping'].includes(element.getAttributeNS(WORD, 'type') ?? '') ? '\v' : '').join(''),
    properties: children(run).find(element => element.localName === 'rPr') === undefined ? null
      : canonical(children(run).find(element => element.localName === 'rPr')!),
  }))
}

function characters(paragraph: XmlElement): { text: string; properties: Canonical | null }[] {
  return textRuns(paragraph).flatMap(run => run.text.split('').map(text => ({ text, properties: run.properties })))
}

function plainText(paragraph: XmlElement): string {
  return textRuns(paragraph).map(run => run.text).join('')
}

function paragraphProperties(paragraph: XmlElement): Canonical | null {
  const properties = children(paragraph).find(element => element.localName === 'pPr')
  return properties === undefined ? null : canonical(properties)
}

function bookmarkPairs(paragraph: XmlElement): Canonical[] {
  return children(paragraph).filter(element => ['bookmarkStart', 'bookmarkEnd'].includes(element.localName ?? '')).map(canonical)
}

describe.skipIf(process.env.DSH_PAPERAI_OFFICECLI_REAL !== '1')('native OfficeCLI metadata preservation', () => {
  let ctx: Context
  let directory: string
  let file: string
  let argv: string[]
  const disposers: (() => void | Promise<void>)[] = []

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'paperai-native-metadata-'))
    file = join(directory, 'proposal.docx')
    await copyFile(proposal, file)
    ctx = new Context()
    const subprocess = await ctx.plugin(LocalSubprocessRuntime)
    disposers.push(() => subprocess.dispose())
    const engine = await ctx.plugin(OfficeCliDocumentEngine, { ...(command === undefined ? {} : { command }), timeoutMs: 30_000 })
    disposers.push(() => engine.dispose())
    const require = createRequire(import.meta.url)
    argv = command === undefined
      ? [process.execPath, join(dirname(dirname(require.resolve('@officecli/officecli'))), 'officecli.js')]
      : [command]
    expect(await ctx.documentEngine.health()).toMatchObject({ status: 'ready', version: '1.0.145' })
  })

  afterEach(async () => {
    if (argv !== undefined && file !== undefined) await native(['close', file])
    for (const dispose of disposers.splice(0).reverse()) await dispose()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  async function native(args: string[]): Promise<Record<string, unknown>> {
    const handle = ctx.subprocess.spawn({
      argv: [...argv, ...args, '--json'], cwd: directory,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8_000_000 }, stderr: { maxBytes: 1_000_000 } },
      graceMs: 1_000, signal: AbortSignal.timeout(30_000),
      env: { OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_RESIDENT_FLUSH: 'each' },
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    expect(outcome, stderr?.text).toMatchObject({ exitCode: 0, signal: null })
    expect(stdout?.lossy).toBe(false)
    const result = JSON.parse(stdout?.text ?? '') as Record<string, unknown>
    expect(result.success).toBe(true)
    return result
  }

  async function raw(): Promise<XmlDocument> {
    const result = await native(['raw', file, '/document'])
    expect(result.data).toBeTypeOf('string')
    return new DOMParser({ onError: onWarningStopParsing }).parseFromString(result.data as string, 'application/xml')
  }

  async function setBody(body: string): Promise<void> {
    const input = join(directory, 'fixture.json')
    await writeFile(input, JSON.stringify([{ command: 'raw-set', part: '/word/document.xml', xpath: '/w:document/w:body', action: 'replace', xml: body }]))
    expect(await native(['batch', file, '--input', input])).toMatchObject({
      data: { results: [{ index: 0, success: true }], summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 } },
    })
    await native(['save', file])
  }

  it('edits Chinese text in the HIT template while retaining every original run property and untouched subtree', async () => {
    const before = await raw()
    expect(new XMLSerializer().serializeToString(before).length).toBeGreaterThan(32_768)
    const original = paragraphs(before)
    const selected = [...new Set([
      original.find(paragraph => plainText(paragraph) === '报告不要设置页眉。')!,
      original.find(paragraph => paragraph.getElementsByTagNameNS(WORD, 'kern').length > 0 && plainText(paragraph).trim() !== '')!,
      original.find(paragraph => children(paragraph).some(child => child.localName === 'bookmarkStart') && plainText(paragraph).trim() !== '')!,
      original.find(paragraph => Array.from(paragraph.getElementsByTagNameNS(WORD, 'rFonts')).some(font =>
        font.hasAttributeNS(WORD, 'eastAsia') && font.getAttributeNS(WORD, 'eastAsia') !== font.getAttributeNS(WORD, 'ascii')) && plainText(paragraph).trim() !== '')!,
    ])]
    expect(selected.every(Boolean)).toBe(true)
    expect(selected.length).toBeGreaterThanOrEqual(3)
    const indexes = selected.map(paragraph => original.indexOf(paragraph))
    expect(await ctx.documentEngine.readTextNodes(file)).toContainEqual(expect.objectContaining({ text: '报告不要设置页眉。' }))
    expect((await ctx.documentEngine.previewHtml(file)).replace(/<[^>]*>/gu, '')).toContain('报告不要设置页眉。')
    await ctx.documentEngine.applyMutations(file, selected.map(paragraph => ({
      type: 'replace-text', officePath: `/body/p[${original.indexOf(paragraph) + 1}]`, text: `${plainText(paragraph)}测`,
    })))
    const after = await raw()
    expect(await ctx.documentEngine.readTextNodes(file)).toContainEqual(expect.objectContaining({ text: '报告不要设置页眉。测' }))
    expect((await ctx.documentEngine.previewHtml(file)).replace(/<[^>]*>/gu, '')).toContain('报告不要设置页眉。测')
    await ctx.documentEngine.release(file)
    expect(canonical((await raw()).documentElement!)).toEqual(canonical(after.documentElement!))
    const actual = paragraphs(after)
    expect(actual.length).toBe(original.length)
    for (const index of indexes) {
      const old = original[index]!
      const updated = actual[index]!
      expect(plainText(updated)).toBe(`${plainText(old)}测`)
      expect(characters(updated).slice(0, -1)).toEqual(characters(old))
      expect(characters(updated).at(-1)?.properties).toEqual(characters(old).at(-1)?.properties)
      expect(paragraphProperties(updated)).toEqual(paragraphProperties(old))
      expect(bookmarkPairs(updated)).toEqual(bookmarkPairs(old))
      old.parentNode!.removeChild(old)
      updated.parentNode!.removeChild(updated)
    }
    expect(canonical(after.documentElement!)).toEqual(canonical(before.documentElement!))
    await ctx.documentEngine.release(file)
  }, 120_000)

  const rPr = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:hint="eastAsia"/>'
    + '<w:bCs/><w:iCs/><w:spacing w:val="20"/><w:kern w:val="28"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr>'
  const pPr = '<w:pPr><w:pStyle w:val="a9"/><w:bidi/><w:spacing w:line="420" w:lineRule="exact"/>'
    + '<w:ind w:left="720" w:right="1440" w:leftChars="100" w:rightChars="200" w:firstLine="480"/></w:pPr>'

  it('uses existing HIT paragraph styles by name and rejects undefined styles without writing the document', async () => {
    const styles = await ctx.documentEngine.readParagraphStyles(file)
    expect(styles).toContainEqual({ id: '2', name: 'Body Text Indent 2' })
    expect(styles).toContainEqual({ id: 'a', name: 'Normal' })
    const stylesResult = await native(['raw', file, '/styles'])
    const styleDocument = new DOMParser({ onError: onWarningStopParsing }).parseFromString(stylesResult.data as string, 'application/xml')
    const paragraphStyleIds = Array.from(styleDocument.getElementsByTagNameNS(WORD, 'style'))
      .filter(style => style.getAttributeNS(WORD, 'type') === 'paragraph').map(style => style.getAttributeNS(WORD, 'styleId'))
    expect(styles.map(style => style.id).sort()).toEqual(paragraphStyleIds.sort())
    const before = paragraphs(await raw())[53]!
    expect(plainText(before)).toBe('报告不要设置页眉。')
    const oldProperties = children(before).find(element => element.localName === 'pPr')!.cloneNode(true) as XmlElement
    for (const style of Array.from(oldProperties.getElementsByTagNameNS(WORD, 'pStyle'))) style.parentNode!.removeChild(style)
    for (const { name, id } of [{ name: 'Body Text Indent 2', id: '2' }, { name: 'Normal', id: 'a' }]) {
      await ctx.documentEngine.applyMutations(file, [{ type: 'replace-text', officePath: '/body/p[54]', text: plainText(before),
        paragraphs: [{ text: plainText(before), format: { style: name } }],
      }])
      const after = paragraphs(await raw())[53]!
      expect(characters(after)).toEqual(characters(before))
      expect(bookmarkPairs(after)).toEqual(bookmarkPairs(before))
      const properties = children(after).find(element => element.localName === 'pPr')!
      const style = properties.getElementsByTagNameNS(WORD, 'pStyle')[0]!
      expect(style.getAttributeNS(WORD, 'val')).toBe(id)
      style.parentNode!.removeChild(style)
      expect(canonical(properties)).toEqual(canonical(oldProperties))
    }
    const savedBytes = await readFile(file)
    await expect(ctx.documentEngine.applyMutations(file, [{ type: 'replace-text', officePath: '/body/p[54]', text: plainText(before),
      paragraphs: [{ text: plainText(before), format: { style: 'Heading1' } }],
    }])).rejects.toThrow('UNKNOWN_PARAGRAPH_STYLE')
    expect(await readFile(file)).toEqual(savedBytes)
    await ctx.documentEngine.release(file)
  }, 120_000)

  it('changes a selected character format without removing mixed fonts, kerning, spacing, language, or bookmarks', async () => {
    await setBody(`<w:body xmlns:w="${WORD}"><w:p>${pPr}<w:bookmarkStart w:id="12345" w:name="selection"/>`
      + `<w:r>${rPr}<w:t>甲乙丙丁</w:t></w:r><w:bookmarkEnd w:id="12345"/></w:p><w:sectPr/></w:body>`)
    const before = paragraphs(await raw())[0]!
    await ctx.documentEngine.applyMutations(file, [{ type: 'replace-text', officePath: '/body/p[1]', text: '甲乙丙丁',
      runs: [{ text: '甲乙', bold: true }, { text: '丙丁' }],
    }])
    const after = paragraphs(await raw())[0]!
    expect(plainText(after)).toBe('甲乙丙丁')
    const boldText = children(after).filter(run => run.localName === 'r' && run.getElementsByTagNameNS(WORD, 'b').length > 0)
      .map(run => Array.from(run.getElementsByTagNameNS(WORD, 't')).map(text => text.textContent).join('')).join('')
    expect(boldText).toBe('甲乙')
    for (const bold of Array.from(after.getElementsByTagNameNS(WORD, 'b'))) bold.parentNode!.removeChild(bold)
    expect(characters(after)).toEqual(characters(before))
    expect(paragraphProperties(after)).toEqual(paragraphProperties(before))
    expect(bookmarkPairs(after)).toEqual(bookmarkPairs(before))
    await ctx.documentEngine.release(file)
  }, 120_000)

  it('keeps a clearing soft break as one text character with its original Word attributes', async () => {
    await setBody(`<w:body xmlns:w="${WORD}"><w:p>${pPr}<w:r>${rPr}<w:t>前行</w:t>`
      + '<w:br w:type="textWrapping" w:clear="all"/><w:t>后行</w:t></w:r></w:p><w:sectPr/></w:body>')
    const before = paragraphs(await raw())[0]!
    expect(plainText(before)).toBe('前行\v后行')
    await ctx.documentEngine.applyMutations(file, [{ type: 'replace-text', officePath: '/body/p[1]', text: '前行\v后行测' }])
    const after = paragraphs(await raw())[0]!
    expect(plainText(after)).toBe('前行\v后行测')
    expect(Array.from(after.getElementsByTagNameNS(WORD, 'br')).map(canonical))
      .toEqual(Array.from(before.getElementsByTagNameNS(WORD, 'br')).map(canonical))
    expect(characters(after).slice(0, -1)).toEqual(characters(before))
    expect(paragraphProperties(after)).toEqual(paragraphProperties(before))
    await ctx.documentEngine.release(file)
  }, 120_000)

  it('preserves an hAnsi-only font through text edits and bold-only overrides', async () => {
    const properties = '<w:rPr><w:rFonts w:hAnsi="宋体"/><w:sz w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr>'
    await setBody(`<w:body xmlns:w="${WORD}"><w:p>${pPr}<w:r>${properties}<w:t>中文ABC</w:t></w:r></w:p><w:sectPr/></w:body>`)
    const before = paragraphs(await raw())[0]!
    await ctx.documentEngine.applyMutations(file, [{ type: 'replace-text', officePath: '/body/p[1]', text: '中文ABC测' }])
    const typed = paragraphs(await raw())[0]!
    expect(characters(typed).slice(0, -1)).toEqual(characters(before))
    expect(characters(typed).at(-1)?.properties).toEqual(characters(before).at(-1)?.properties)
    await ctx.documentEngine.applyMutations(file, [{ type: 'replace-text', officePath: '/body/p[1]', text: '中文ABC测',
      runs: [{ text: '中文', bold: true }, { text: 'ABC测' }],
    }])
    const after = paragraphs(await raw())[0]!
    expect(plainText(after)).toBe('中文ABC测')
    const selected = children(after).filter(run => run.localName === 'r' && run.getElementsByTagNameNS(WORD, 'b').length > 0)
    expect(selected.map(run => run.getElementsByTagNameNS(WORD, 't')[0]?.textContent).join('')).toBe('中文')
    for (const font of Array.from(after.getElementsByTagNameNS(WORD, 'rFonts'))) {
      expect(Array.from(font.attributes).map(attribute => [attribute.localName, attribute.value])).toEqual([['hAnsi', '宋体']])
    }
    await ctx.documentEngine.release(file)
    expect(canonical(paragraphs(await raw())[0]!)).toEqual(canonical(after))
    for (const bold of Array.from(after.getElementsByTagNameNS(WORD, 'b'))) bold.parentNode!.removeChild(bold)
    expect(characters(after)).toEqual(characters(typed))
    expect(paragraphProperties(after)).toEqual(paragraphProperties(before))
    await ctx.documentEngine.release(file)
  }, 120_000)

  it('binds original ordinal targets before splitting, keeps page and bookmark anchors, and refuses an edited field', async () => {
    await setBody(`<w:body xmlns:w="${WORD}"><w:p>${pPr}<w:bookmarkStart w:id="12345" w:name="split"/>`
      + `<w:r>${rPr}<w:br w:type="page"/><w:t>甲乙丙丁</w:t><w:lastRenderedPageBreak/></w:r><w:bookmarkEnd w:id="12345"/></w:p>`
      + `<w:p>${pPr}<w:r>${rPr}<w:t>相同原段</w:t></w:r></w:p><w:p><w:r><w:t>相同原段</w:t></w:r></w:p>`
      + '<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>日期</w:t></w:r></w:fldSimple></w:p><w:sectPr/></w:body>')
    const before = paragraphs(await raw())
    await ctx.documentEngine.applyMutations(file, [
      { type: 'replace-text', officePath: '/body/p[1]', text: '甲乙\n丙丁', paragraphs: [{ text: '甲乙' }, { text: '丙丁' }] },
      { type: 'replace-text', officePath: '/body/p[2]', text: '第二原段已改' },
      { type: 'remove', officePath: '/body/p[3]' },
    ])
    const updated = await raw()
    const after = paragraphs(updated)
    expect(after.length).toBe(4)
    expect(after.slice(0, 3).map(plainText)).toEqual(['甲乙', '丙丁', '第二原段已改'])
    expect(after.slice(0, 2).flatMap(characters)).toEqual(characters(before[0]!))
    expect(after.slice(0, 2).map(paragraphProperties)).toEqual([paragraphProperties(before[0]!), paragraphProperties(before[0]!)])
    expect(after.slice(0, 2).flatMap(bookmarkPairs)).toEqual(bookmarkPairs(before[0]!))
    expect(updated.getElementsByTagNameNS(WORD, 'br').length).toBe(1)
    expect(updated.getElementsByTagNameNS(WORD, 'br')[0]!.getAttributeNS(WORD, 'type')).toBe('page')
    expect(updated.getElementsByTagNameNS(WORD, 'lastRenderedPageBreak').length).toBe(1)
    expect(canonical(after[3]!)).toEqual(canonical(before[3]!))
    await expect(ctx.documentEngine.applyMutations(file, [{ type: 'replace-text', officePath: '/body/p[4]', text: '改动域' }]))
      .rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(canonical((await raw()).documentElement!)).toEqual(canonical(updated.documentElement!))
    await ctx.documentEngine.release(file)
  }, 120_000)
})
