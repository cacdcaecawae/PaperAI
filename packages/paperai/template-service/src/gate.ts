/** Live document checks for confirmed PaperAI template contracts. */

import { createHash } from 'node:crypto'
import type { DocumentEngine, EngineTextNode } from '@paperai/document-engine'
import type {
  DocumentRecord,
  GateFinding,
  GateMode,
  GateReport,
  RuleSeverity,
  TemplateContract,
  TemplateRule,
} from '@paperai/domain'
import { parseBodyInspection } from './inspection.ts'
import type { InspectedWordNode } from './inspection.ts'

type FindingExtra = Omit<Partial<GateFinding>, 'id' | 'severity' | 'code' | 'message'>

/**
 * Check the current Working DOCX against its attached template contract.
 * A document that names no template is in templateless free mode: the report
 * passes with no findings in every mode, so neither draft nor formal delivery
 * export is blocked; attaching a template is what opts into checks. A document
 * that names a template whose record cannot be resolved is corrupt, not free:
 * it fails with `template_missing` until the association is repaired.
 * @param engine - Office document engine used for live text, style, and structure evidence.
 * @param document - authoritative Working DOCX record.
 * @param template - resolved attached template, or `undefined` when the document names none or its record is missing.
 * @param mode - continuous, draft-export, or formal delivery behavior.
 * @param signal - optional cancellation signal.
 * @returns a complete report; hard findings block only formal delivery export.
 */
export async function checkTemplateContract(
  engine: DocumentEngine,
  document: DocumentRecord,
  template: TemplateContract | undefined,
  mode: GateMode,
  signal?: AbortSignal,
): Promise<GateReport> {
  const findings: GateFinding[] = []
  if (template === undefined) {
    if (document.templateId !== undefined) {
      findings.push(finding('template-missing', 'error', 'template_missing', `文档关联的模板 ${document.templateId} 已不存在，请重新关联模板`, {
        expected: document.templateId,
      }))
    }
    return report(document, undefined, mode, findings)
  }
  if (template.status !== 'confirmed') {
    findings.push(finding('template-unconfirmed', 'error', 'template_unconfirmed', '关联模板仍是草稿，请先人工确认'))
  }
  if (!template.appliesToRoles.includes(document.role)) {
    findings.push(finding('template-role', 'error', 'template_role_mismatch', `模板不适用于文档角色 ${document.role}`, {
      expected: template.appliesToRoles,
      actual: document.role,
    }))
  }

  let textNodes: EngineTextNode[]
  let inspected: InspectedWordNode[]
  try {
    const [text, body, validation] = await Promise.all([
      engine.readTextNodes(document.workingPath, signal),
      engine.inspect(document.workingPath, '/body', 1, signal),
      engine.validate(document.workingPath, signal),
    ])
    textNodes = text
    inspected = parseBodyInspection(body)
    if (!validation.success) {
      findings.push(finding('document-invalid', 'error', 'document_invalid', 'Word 文档结构校验未通过', {
        actual: validation.details,
      }))
    }
  } catch (error) {
    findings.push(finding('inspection-failed', 'error', 'template_inspection_failed', `无法检查 Word 文档：${errorMessage(error)}`))
    return report(document, template, mode, findings)
  }

  const textByPath = new Map(textNodes.map(node => [node.officePath, node.text]))
  const inspectedByPath = new Map(inspected.map(node => [node.path, node]))
  const joinedText = textNodes.map(node => node.text).join('\n')
  for (const rule of template.rules) {
    if (!rule.enabled) continue
    checkRule(rule, textNodes, inspected, textByPath, inspectedByPath, joinedText, findings)
  }
  return report(document, template, mode, findings)
}

function checkRule(
  rule: TemplateRule,
  textNodes: readonly EngineTextNode[],
  inspected: readonly InspectedWordNode[],
  textByPath: ReadonlyMap<string, string>,
  inspectedByPath: ReadonlyMap<string, InspectedWordNode>,
  joinedText: string,
  findings: GateFinding[],
): void {
  switch (rule.kind) {
    case 'fixed-text':
    case 'required-section': {
      const expected = expectedString(rule.expected, 'text')
      if (expected !== undefined && !canonical(joinedText).includes(canonical(expected))) {
        findings.push(ruleFinding(rule, `${rule.kind.replace('-', '_')}_missing`, `缺少${rule.kind === 'fixed-text' ? '固定文字' : '必需章节'}：${expected}`, { expected }))
      }
      return
    }
    case 'required-field': {
      const path = expectedString(rule.expected, 'officePath') ?? rule.scope
      const templateText = expectedString(rule.expected, 'templateText')
      const label = expectedString(rule.expected, 'label') ?? rule.label
      const actual = path === undefined ? undefined : textByPath.get(path)
      if (actual === undefined || !fieldHasValue(actual, templateText)) {
        findings.push(ruleFinding(rule, 'required_field_empty', `必填字段未填写：${label}`, {
          ...(path === undefined ? {} : { officePath: path }),
          expected: '非占位内容',
          actual,
        }))
      }
      return
    }
    case 'font':
      checkFont(rule, inspected, findings)
      return
    case 'font-size':
      checkFontSize(rule, inspected, findings)
      return
    case 'paragraph-spacing':
      checkParagraphSpacing(rule, inspected, findings)
      return
    case 'page-setup':
      checkPageSetup(rule, inspected, findings)
      return
    case 'minimum-characters':
      checkMinimumCharacters(rule, textNodes, inspectedByPath, findings)
      return
    case 'reference-count':
      checkReferenceCount(rule, textNodes, findings)
      return
    case 'table-structure': {
      const minimum = expectedNumber(rule.expected, 'minimumTables')
      const actual = textNodes.filter(node => node.kind === 'table').length
      if (minimum !== undefined && actual < minimum) {
        findings.push(ruleFinding(rule, 'table_structure_missing', `表格数量少于模板要求：${actual}/${minimum}`, {
          expected: minimum,
          actual,
        }))
      }
      return
    }
    case 'placeholder': {
      if (hasPlaceholder(joinedText)) {
        findings.push(ruleFinding(rule, 'placeholder_remaining', '文档仍包含未替换占位符'))
      }
      return
    }
    case 'file-integrity':
    case 'template-identity':
    case 'cross-document-fact':
    case 'visual-layout':
    case 'custom':
      return
  }
}

function checkFont(rule: TemplateRule, inspected: readonly InspectedWordNode[], findings: GateFinding[]): void {
  const target = expectedString(rule.expected, 'target') ?? 'body'
  const candidates = styleCandidates(inspected, target)
  const expectedEastAsia = expectedString(rule.expected, 'eastAsia')
  const expectedLatin = expectedString(rule.expected, 'latin')
  if (expectedEastAsia !== undefined) {
    const actual = dominant(candidates.flatMap(node => valueFrom(node.format, [
      'effective.font.eastAsia', 'font.eastAsia', 'font.ea',
    ])))
    compareStyleValue(rule, 'font_mismatch', expectedEastAsia, actual, findings)
  }
  if (expectedLatin !== undefined) {
    const actual = dominant(candidates.flatMap(node => valueFrom(node.format, [
      'effective.font.ascii', 'effective.font.hAnsi', 'font.ascii', 'font.latin',
    ])))
    compareStyleValue(rule, 'latin_font_mismatch', expectedLatin, actual, findings)
  }
}

function checkFontSize(rule: TemplateRule, inspected: readonly InspectedWordNode[], findings: GateFinding[]): void {
  const expected = expectedNumber(rule.expected, 'points')
  if (expected === undefined) return
  const target = expectedString(rule.expected, 'target') ?? 'body'
  const actual = dominant(styleCandidates(inspected, target).flatMap(node => valueFrom(node.format, [
    'effective.size', 'size', 'markRPr.size',
  ]).flatMap(parsePoints)))
  compareStyleValue(rule, 'font_size_mismatch', expected, actual, findings)
}

function checkParagraphSpacing(rule: TemplateRule, inspected: readonly InspectedWordNode[], findings: GateFinding[]): void {
  const target = expectedString(rule.expected, 'target') ?? 'body'
  const candidates = styleCandidates(inspected, target)
  const expectedBefore = expectedNumber(rule.expected, 'beforeLines')
  const expectedAfter = expectedNumber(rule.expected, 'afterLines')
  if (expectedBefore !== undefined) {
    const actual = dominant(candidates.map(node => numericFormat(node.format, 'spaceBeforeLines') ?? 0))
    compareStyleValue(rule, 'paragraph_before_mismatch', expectedBefore, actual, findings)
  }
  if (expectedAfter !== undefined) {
    const actual = dominant(candidates.map(node => numericFormat(node.format, 'spaceAfterLines') ?? 0))
    compareStyleValue(rule, 'paragraph_after_mismatch', expectedAfter, actual, findings)
  }
}

function checkPageSetup(rule: TemplateRule, inspected: readonly InspectedWordNode[], findings: GateFinding[]): void {
  const sections = inspected.filter(node => node.type === 'section')
  const expectedHeader = expectedBoolean(rule.expected, 'header')
  if (expectedHeader === false && sections.some(section => Object.keys(section.format).some(key => key.startsWith('headerRef')))) {
    findings.push(ruleFinding(rule, 'header_present', '模板要求不设置页眉'))
  }
  const expectedSections = expectedRecords(rule.expected, 'sections')
  if (expectedSections.length === 0) return
  const keys = [
    'pageWidth', 'pageHeight', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'marginHeader', 'marginFooter', 'marginGutter', 'columns', 'columnSpace',
  ] as const
  const expected = expectedSections[0]
  const actual = sections[0]?.format
  if (expected === undefined || actual === undefined) {
    findings.push(ruleFinding(rule, 'page_setup_missing', '无法找到文档页面设置'))
    return
  }
  for (const key of keys) {
    if (expected[key] === undefined) continue
    if (actual[key] !== expected[key]) {
      findings.push(ruleFinding(rule, 'page_setup_mismatch', `页面设置不一致：${key}`, {
        expected: expected[key],
        actual: actual[key],
      }))
    }
  }
}

function checkMinimumCharacters(
  rule: TemplateRule,
  textNodes: readonly EngineTextNode[],
  inspectedByPath: ReadonlyMap<string, InspectedWordNode>,
  findings: GateFinding[],
): void {
  const minimum = expectedNumber(rule.expected, 'minimum')
  if (minimum === undefined) return
  const heading = expectedString(rule.expected, 'heading')
  const selected = heading === undefined
    ? textNodes
    : sectionNodes(textNodes, inspectedByPath, heading)
  const actual = selected.reduce((sum, node) => sum + canonical(node.text).length, 0)
  if (actual < minimum) {
    findings.push(ruleFinding(rule, 'minimum_characters', `字数不足：${actual}/${minimum}`, {
      expected: minimum,
      actual,
    }))
  }
}

function checkReferenceCount(rule: TemplateRule, textNodes: readonly EngineTextNode[], findings: GateFinding[]): void {
  const minimum = expectedNumber(rule.expected, 'minimum')
  if (minimum === undefined) return
  const actual = textNodes.filter(node => /^\s*[［[]?\d+[］\].、]/u.test(node.text)).length
  if (actual < minimum) {
    findings.push(ruleFinding(rule, 'reference_count', `参考文献数量不足：${actual}/${minimum}`, {
      expected: minimum,
      actual,
    }))
  }
}

function sectionNodes(
  nodes: readonly EngineTextNode[],
  inspectedByPath: ReadonlyMap<string, InspectedWordNode>,
  heading: string,
): readonly EngineTextNode[] {
  const start = nodes.findIndex(node => canonical(node.text).includes(canonical(heading)))
  if (start < 0) return []
  let end = nodes.length
  for (let index = start + 1; index < nodes.length; index += 1) {
    const candidate = nodes[index]
    if (candidate !== undefined && isHeading(inspectedByPath.get(candidate.officePath))) {
      end = index
      break
    }
  }
  return nodes.slice(start + 1, end)
}

function styleCandidates(inspected: readonly InspectedWordNode[], target: string): InspectedWordNode[] {
  const textBearing = inspected.filter(node => node.type === 'paragraph' && node.text.trim().length > 0)
  if (target === 'body') return textBearing.filter(node => !isHeading(node))
  if (target === 'heading') return textBearing.filter(isHeading)
  const level = /heading-(\d)/u.exec(target)?.[1]
  if (level === undefined) return textBearing
  return textBearing.filter(node => node.styleName?.toLowerCase().includes(`heading ${level}`) === true)
}

function isHeading(node: InspectedWordNode | undefined): boolean {
  if (node === undefined) return false
  return node.styleName?.toLowerCase().includes('heading') === true
    || /^(?:第\s*\d+\s*章|\d+(?:\.\d+)+\s+|摘\s*要$|Abstract$|目\s*录$|参考文献$|结\s*论$)/u.test(node.text.trim())
}

function fieldHasValue(actual: string, templateText: string | undefined): boolean {
  if (templateText !== undefined && canonical(actual) === canonical(templateText)) return false
  const field = actual
    .replace(/^[^：:]{1,24}[：:]/u, '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/[\s_＿×□*]+/gu, '')
  return field.length > 0 && !hasPlaceholder(field)
}

function hasPlaceholder(text: string): boolean {
  return /\{\{[^{}]+\}\}|_{2,}|＿{2,}|×{2,}|□{2,}/u.test(text)
}

function compareStyleValue(
  rule: TemplateRule,
  code: string,
  expected: string | number,
  actual: string | number | undefined,
  findings: GateFinding[],
): void {
  if (actual !== undefined && normalizedComparable(actual) === normalizedComparable(expected)) return
  findings.push(ruleFinding(rule, code, `样式不符合要求：${rule.label}`, { expected, actual }))
}

function normalizedComparable(value: string | number): string {
  return String(value).trim().toLowerCase()
}

function valueFrom(format: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = format[key]
    if (typeof value === 'string' && value.length > 0) return [value]
  }
  return []
}

function parsePoints(value: string): number[] {
  const match = /^([\d.]+)pt$/u.exec(value.trim())
  return match?.[1] === undefined ? [] : [Number(match[1])]
}

function numericFormat(format: Record<string, unknown>, key: string): number | undefined {
  const value = format[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function dominant<T extends string | number>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>()
  let winner: T | undefined
  let winnerCount = 0
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    if (count > winnerCount) {
      winner = value
      winnerCount = count
    }
  }
  return winner
}

function expectedRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function expectedString(value: unknown, key: string): string | undefined {
  const selected = expectedRecord(value)?.[key]
  return typeof selected === 'string' ? selected : undefined
}

function expectedNumber(value: unknown, key: string): number | undefined {
  const selected = expectedRecord(value)?.[key]
  return typeof selected === 'number' && Number.isFinite(selected) ? selected : undefined
}

function expectedBoolean(value: unknown, key: string): boolean | undefined {
  const selected = expectedRecord(value)?.[key]
  return typeof selected === 'boolean' ? selected : undefined
}

function expectedRecords(value: unknown, key: string): Record<string, unknown>[] {
  const selected = expectedRecord(value)?.[key]
  if (!Array.isArray(selected)) return []
  return selected.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
}

function canonical(value: string): string {
  return value.normalize('NFKC').replaceAll(/\s+/gu, '')
}

function ruleFinding(
  rule: TemplateRule,
  code: string,
  message: string,
  extra: FindingExtra = {},
): GateFinding {
  return finding(`${rule.id}:${code}:${extra.officePath ?? ''}`, rule.severity, code, message, {
    ruleId: rule.id,
    ...extra,
  })
}

function finding(
  seed: string,
  severity: RuleSeverity,
  code: string,
  message: string,
  extra: FindingExtra = {},
): GateFinding {
  return {
    id: `finding-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`,
    severity,
    code,
    message,
    ...extra,
  }
}

function report(
  document: DocumentRecord,
  template: TemplateContract | undefined,
  mode: GateMode,
  findings: GateFinding[],
): GateReport {
  const failed = findings.some(item => item.severity === 'error' && item.overridden !== true)
  return {
    status: failed ? 'fail' : findings.length > 0 ? 'pass-with-exceptions' : 'pass',
    mode,
    documentId: document.id,
    ...(template === undefined ? {} : { templateId: template.id }),
    findings,
    checkedAt: new Date().toISOString(),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
