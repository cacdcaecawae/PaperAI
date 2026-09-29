/** Validation of OfficeCLI inspection values used by template compilation and checks. */

/** Word's table-of-contents entry styles, such as `toc 1`, `TOC1`, or `目录 1`; their text repeats a heading. */
const TOC_STYLE = /^(?:toc|目录)\s*\d+$/iu

/**
 * An originality declaration's title: an optional institution and degree, the declaration, and an optional grant of
 * use, as in 哈尔滨工业大学学位论文原创性声明和使用权限. A sentence that mentions a declaration is not a title.
 */
const DECLARATION_TITLE = /^(?:\S{0,20}?(?:大学|学院))?(?:(?:博士|硕士)?学位论文)?(?:原创性|独创性)声明(?:(?:和|及|与)?(?:版权)?使用(?:权限|授权(?:书|说明)?))?$/u

/** Word's built-in heading styles as a Chinese Word or WPS file names them, `标题 1` to `标题 9`; bare `标题` is the Title style. */
const LOCALIZED_HEADING_STYLE = /^标题\s*([1-9])$/u

/**
 * The level of a Word heading style, from `heading 2` or its localized `标题 2`.
 * @param styleName - paragraph style name, when it has one.
 * @returns the level, or `undefined` for any other style.
 */
export function headingLevel(styleName: string | undefined): number | undefined {
  const level = /heading\s*([1-9])/iu.exec(styleName ?? '')?.[1] ?? LOCALIZED_HEADING_STYLE.exec(styleName ?? '')?.[1]
  return level === undefined ? undefined : Number(level)
}

/**
 * A section number opening a heading, in every form a sample numbers its sections: 第5章, 第一节, Chapter 1 (each with
 * an optional colon, period, or 、 after it, as in 第1章：绪论), ①, 1、, 1), 一、 or 一 followed by a space, 1.1, and 1．
 * or 1 followed by a space. Specific forms come first, so 1、 is not read as 1 followed by text, and a bare number needs
 * a separator, so 2019年 is not numbered.
 */
const NUMERALS = '一二三四五六七八九十百零〇两'
const SECTION_NUMBER = new RegExp(`^(?:(?:第\\s*[\\d${NUMERALS}]+\\s*[章节]|chapter\\s+\\d+)(?:\\s*[:.、])?|[①-⑳]|\\d+[、)）]|[${NUMERALS}]+[、．.)）\\s]`
  + '|\\d+(?:\\.\\d+)+[．.]?|\\d+[．.\\s])\\s*', 'iu')

/**
 * Full-width ASCII forms and the ideographic space as their half-width forms, as East Asian Word and WPS files often
 * type section numbers (第１章, １．１　). Unlike NFKC it leaves circled numbers such as ① for `SECTION_NUMBER`, and it
 * maps one code unit to one, so a match's length also measures the original text.
 * @param text - heading text.
 * @returns the text with half-width letters, digits, punctuation, and spaces.
 */
export function halfWidth(text: string): string {
  return text.replaceAll(/[\uFF01-\uFF5E]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replaceAll('\u3000', ' ')
}

/**
 * The text after an opening section number, in its original characters; the number is found on the half-width form.
 * @param text - trimmed heading text.
 * @returns the rest of the text, or `undefined` when no section number opens it.
 */
function afterSectionNumber(text: string): string | undefined {
  const number = SECTION_NUMBER.exec(halfWidth(text))
  return number === null ? undefined : text.slice(number[0].length)
}

/**
 * A parenthesized note that ends a heading, closed or not, as in 研究背景（示例） or 研究背景（示例. A parenthetical that
 * title text follows, as in 实验结果（含分析）与讨论, is part of the title.
 */
const TRAILING_NOTE = /\s*[（(][^（()）]*[）)]?\s*$/u

/**
 * A numbered paragraph set in body text counts as a heading only when what follows its number reads as a title:
 * at most 40 characters and no sentence punctuation, a trailing parenthesized note aside. A numbered list item
 * such as 1、首先……，然后…… stays body text.
 */
function isNumberedTitle(text: string): boolean {
  const rest = afterSectionNumber(text)
  if (rest === undefined) return false
  const title = rest.replace(TRAILING_NOTE, '').trim()
  return title.length <= 40 && !/[。，；：！？,;:!?]/u.test(title)
}

/**
 * A section heading's title without its section number or a trailing parenthesized note, as a sample's required
 * section is recorded and a manuscript's heading is compared: `1.1 研究背景（示例）` and `第5章 结论` read `研究背景`
 * and `结论`.
 * @param text - heading text.
 * @returns the trimmed title.
 */
export function sectionLabel(text: string): string {
  const trimmed = text.trim()
  return (afterSectionNumber(trimmed) ?? trimmed).replace(TRAILING_NOTE, '').trim()
}

/**
 * Whether a paragraph opens with a section number, as the sample's own numbered research headings do.
 * @param text - paragraph text.
 * @returns true when `SECTION_NUMBER` matches.
 */
export function hasSectionNumber(text: string): boolean {
  return SECTION_NUMBER.test(halfWidth(text).trim())
}

/**
 * The key two section titles are compared by, in a sample and in a manuscript: the `sectionLabel` without
 * whitespace, Unicode-normalized and case-folded, so `第6章 结 论` and `结论` name the same section.
 * @param text - heading text or a declared section title.
 * @returns the comparison key.
 */
export function sectionKey(text: string): string {
  return sectionLabel(text).normalize('NFKC').replaceAll(/\s+/gu, '').toLowerCase()
}

/**
 * Whether a paragraph is a heading, for a template sample and a checked manuscript alike. A Word heading style,
 * English or localized, counts, a TOC entry style never does, and so does text only a heading carries: a numbered chapter or section,
 * or a common thesis section title set in body text, such as `致  谢`, `ABSTRACT`, or an originality declaration.
 * OfficeCLI reports no outline level, so any other title set in body text is not recognized.
 * @param text - paragraph text.
 * @param styleName - paragraph style name, when it has one.
 * @returns true for a heading.
 */
export function isHeadingParagraph(text: string, styleName: string | undefined): boolean {
  if (TOC_STYLE.test(styleName ?? '')) return false
  if (styleName?.toLowerCase().includes('heading') === true || LOCALIZED_HEADING_STYLE.test(styleName ?? '')) return true
  const trimmed = text.trim()
  // A trailing note does not hide a common title, as in 结论（本章总结）, since sectionKey() drops it too.
  const compact = trimmed.replace(TRAILING_NOTE, '').replaceAll(/\s+/gu, '')
  return isNumberedTitle(trimmed)
    || /^(?:摘要|abstract|目录|结论|参考文献|致谢|acknowledge?ments?)$/iu.test(compact)
    || DECLARATION_TITLE.test(compact)
}

/** One body child with safe primitive format evidence. */
export interface InspectedWordNode {
  readonly path: string
  readonly type: string
  readonly text: string
  readonly styleName?: string
  readonly format: Record<string, unknown>
}

/**
 * Parse the durable OfficeCLI JSON boundary without retaining raw XML fields.
 * @param value - data envelope returned by `DocumentEngine.inspect()`.
 * @returns validated body children in Office order.
 */
export function parseBodyInspection(value: Record<string, unknown>): InspectedWordNode[] {
  const results = records(value.results)
  const body = results.find(result => result.type === 'body') ?? results[0]
  if (body === undefined) return []
  return records(body.children).flatMap((child): InspectedWordNode[] => {
    const path = stringValue(child.path)
    if (path.length === 0) return []
    const styleName = optionalString(child.style)
    return [{
      path,
      type: stringValue(child.type),
      text: optionalString(child.text) ?? '',
      ...(styleName === undefined ? {} : { styleName }),
      format: sanitizeRecord(child.format),
    }]
  })
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'xml' && !key.endsWith('.xml')))
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
