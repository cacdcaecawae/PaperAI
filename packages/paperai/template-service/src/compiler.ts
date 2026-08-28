/** OfficeCLI inspection compiler for reviewable PaperAI template drafts. */

import { createHash } from 'node:crypto'
import type { DocumentEngine, EngineTextNode } from '@paperai/document-engine'
import {
  DocumentId,
  DocumentNodeId,
  TemplateContractId,
  TemplateRuleId,
} from '@paperai/domain'
import type {
  DocumentNode,
  DocumentRecord,
  DocumentRole,
  ProjectId,
  TemplateContract,
  TemplateOrigin,
  TemplateRule,
  TemplateRuleKind,
  TemplateSlot,
  TemplateUsage,
} from '@paperai/domain'
import type { StoredTemplateAssets } from './storage.ts'
import { parseBodyInspection } from './inspection.ts'
import type { InspectedWordNode } from './inspection.ts'

/** Complete records published before a draft contract becomes visible. */
export interface CompiledTemplateDraft {
  readonly document: DocumentRecord
  readonly nodes: readonly DocumentNode[]
  readonly contract: TemplateContract
}

/** Inputs whose identities and immutable assets are owned by the template service. */
export interface CompileTemplateDraftInput {
  readonly projectId: ProjectId
  readonly templateId: TemplateContractId
  readonly sourceDocumentId: DocumentId
  readonly name: string
  readonly appliesToRoles: readonly DocumentRole[]
  readonly usage: TemplateUsage
  readonly assets: StoredTemplateAssets
  readonly origin: TemplateOrigin
  readonly now: string
}

/**
 * Compile OfficeCLI text and format evidence into durable nodes and a draft contract.
 * @param engine - configured PaperAI document engine.
 * @param input - service-owned identities, provenance, roles, and immutable paths.
 * @param signal - optional cancellation signal.
 * @returns a source document, semantic nodes, and the reviewable draft.
 */
export async function compileTemplateDraft(
  engine: DocumentEngine,
  input: CompileTemplateDraftInput,
  signal?: AbortSignal,
): Promise<CompiledTemplateDraft> {
  const [textNodes, bodyInspection] = await Promise.all([
    engine.readTextNodes(input.assets.normalizedPath, signal),
    engine.inspect(input.assets.normalizedPath, '/body', 1, signal),
  ])
  const inspected = parseBodyInspection(bodyInspection)
  const formats = new Map(inspected.map(node => [node.path, node]))
  const nodes = textNodes.map((node, ordinal) =>
    compileNode(input.sourceDocumentId, node, formats.get(node.officePath), ordinal, input.now))
  const nodeByPath = new Map(nodes.map(node => [node.officePath, node]))
  const instructions = nodes.filter(node => isInstruction(node.text))
  const fixed = nodes.filter(node => isFixedText(node.text, input.usage))
  const slots = input.usage === 'form-template' ? compileSlots(nodes) : []
  const rules: TemplateRule[] = []

  for (const node of fixed) {
    rules.push(makeRule(input.sourceDocumentId, node, 'fixed-text', `保留固定文字：${compactLabel(node.text)}`, 'error', {
      text: node.text,
    }))
  }
  for (const slot of slots) {
    const node = nodeByPath.get(slot.officePath)
    /* v8 ignore next -- compileSlots derives every officePath from the same nodes used to build nodeByPath. */
    if (node === undefined) continue
    rules.push(makeRule(input.sourceDocumentId, node, 'required-field', `填写${slot.label}`, 'error', {
      slotId: slot.id,
      key: slot.key,
      label: slot.label,
      officePath: slot.officePath,
      templateText: node.text,
    }))
  }
  for (const node of compileRequiredSections(nodes, input.usage)) {
    rules.push(makeRule(input.sourceDocumentId, node, 'required-section', `包含章节：${compactLabel(node.text)}`, 'error', {
      text: sectionLabel(node.text),
    }))
  }
  compileTextRequirements(nodes, input.sourceDocumentId, rules)

  const pageSetup = compilePageSetup(inspected)
  if (Object.keys(pageSetup).length > 0) {
    const source = instructions.at(0) ?? nodes.at(0)
    rules.push(makeRule(input.sourceDocumentId, source, 'page-setup', '页面设置与模板一致', 'error', pageSetup, '/body'))
  }
  const tableCount = textNodes.filter(node => node.kind === 'table').length
  if (input.usage === 'form-template' && tableCount > 0) {
    const table = nodes.find(node => node.kind === 'table')
    rules.push(makeRule(input.sourceDocumentId, table, 'table-structure', '保留模板表格结构', 'error', { minimumTables: tableCount }))
  }

  const document: DocumentRecord = {
    id: input.sourceDocumentId,
    projectId: input.projectId,
    documentKind: 'template-source',
    name: input.name,
    role: input.appliesToRoles[0] ?? 'other',
    immutableSourcePath: input.assets.immutableSourcePath,
    workingPath: input.assets.normalizedPath,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: input.assets.sourceSha256,
    nodeCount: nodes.length,
    createdAt: input.now,
    updatedAt: input.now,
  }
  const contract: TemplateContract = {
    id: input.templateId,
    projectId: input.projectId,
    name: input.name,
    sourceDocumentId: input.sourceDocumentId,
    version: 1,
    rules: deduplicateRules(rules),
    slots,
    fixedNodeIds: fixed.map(node => node.id),
    instructionNodeIds: instructions.map(node => node.id),
    pageSetup,
    styleMap: compileStyleMap(inspected),
    origin: input.origin,
    appliesToRoles: [...input.appliesToRoles],
    usage: input.usage,
    status: 'draft',
    createdAt: input.now,
    updatedAt: input.now,
  }
  return { document, nodes, contract }
}

function compileNode(
  documentId: DocumentId,
  textNode: EngineTextNode,
  inspected: InspectedWordNode | undefined,
  ordinal: number,
  now: string,
): DocumentNode {
  const style = inspected?.format ?? {}
  const kind = textNode.kind === 'table'
    ? 'table'
    : isHeading(textNode.text, inspected?.styleName) ? 'heading' : textNode.kind
  return {
    id: DocumentNodeId(`node-${digest(`${documentId}\0${textNode.officePath}`).slice(0, 24)}`),
    documentId,
    officePath: textNode.officePath,
    ordinal,
    kind,
    text: textNode.text,
    style,
    hash: digest(JSON.stringify({ text: textNode.text, style })),
    lineage: [],
    updatedAt: now,
  }
}

function compileStyleMap(inspected: readonly InspectedWordNode[]): Record<string, unknown> {
  const styles: Record<string, unknown> = {}
  for (const node of inspected) {
    const name = node.styleName
    if (name === undefined || name.length === 0 || styles[name] !== undefined) continue
    styles[name] = node.format
  }
  return styles
}

function compilePageSetup(inspected: readonly InspectedWordNode[]): Record<string, unknown> {
  const sections = inspected
    .filter(node => node.type === 'section')
    .map(node => ({ officePath: node.path, ...node.format }))
  return sections.length === 0 ? {} : { sections }
}

function compileSlots(nodes: readonly DocumentNode[]): TemplateSlot[] {
  const slots: TemplateSlot[] = []
  for (const node of nodes) {
    const field = fieldFor(node.text)
    if (field === undefined) continue
    slots.push({
      id: `slot-${digest(`${node.documentId}\0${node.officePath}\0${field.key}`).slice(0, 20)}`,
      key: field.key,
      label: field.label,
      officePath: node.officePath,
      type: field.key.endsWith('Date') ? 'date' : field.key === 'title' ? 'long-text' : 'text',
      required: true,
      repeatable: false,
    })
  }
  return slots
}

interface FieldDefinition {
  key: string
  label: string
  pattern: RegExp
}

const FIELDS: readonly FieldDefinition[] = [
  { key: 'title', label: '题目', pattern: /题\s*目\s*[：:]/u },
  { key: 'school', label: '学院（部）', pattern: /学\s*院(?:\s*[（(]部[）)])?/u },
  { key: 'discipline', label: '学科/专业学位类别', pattern: /学\s*科\s*\/\s*专\s*业\s*学\s*位\s*类\s*别/u },
  { key: 'supervisor', label: '导师', pattern: /导\s*师(?=\s{2,}|[：:])/u },
  { key: 'studentName', label: '研究生', pattern: /研\s*究\s*生(?=\s{2,}|[：:])/u },
  { key: 'studentId', label: '学号', pattern: /学\s*号(?=\s{2,}|[：:])/u },
  { key: 'reportDate', label: '报告日期', pattern: /(?:开题|中期)?\s*报\s*告\s*日\s*期/u },
]

function fieldFor(text: string): FieldDefinition | undefined {
  return FIELDS.find(field => field.pattern.test(text))
}

function compileRequiredSections(nodes: readonly DocumentNode[], usage: TemplateUsage): DocumentNode[] {
  if (usage === 'format-reference') {
    return nodes.filter(node => node.kind === 'heading' && node.text.trim().length > 0 && node.text.length <= 100)
  }
  const sections: DocumentNode[] = []
  let inOutline = false
  for (const node of nodes) {
    const text = node.text.trim()
    if (/应包括下列主要内容/u.test(text)) {
      inOutline = true
      continue
    }
    if (inOutline && /^[二三四五六七八九十]+、/u.test(text)) break
    if (inOutline && /^\d+(?:\.\d+)*[．.]/u.test(text) && text.length <= 140) sections.push(node)
  }
  return sections
}

function compileTextRequirements(
  nodes: readonly DocumentNode[],
  documentId: DocumentId,
  rules: TemplateRule[],
): void {
  for (const node of nodes) {
    const text = node.text.trim()
    const minimum = /不少于\s*(\d+)\s*字/u.exec(text)
    if (minimum?.[1] !== undefined) {
      rules.push(makeRule(documentId, node, 'minimum-characters', `满足字数要求：${minimum[1]} 字`, 'error', {
        minimum: Number(minimum[1]),
        heading: /^\d/u.test(text) ? sectionLabel(text) : undefined,
      }))
    }
    const overallMinimum = /字数应在\s*(\d+)\s*字以上/u.exec(text)
    if (overallMinimum?.[1] !== undefined) {
      rules.push(makeRule(documentId, node, 'minimum-characters', `全文不少于 ${overallMinimum[1]} 字`, 'error', {
        minimum: Number(overallMinimum[1]),
      }))
    }
    const references = /参考文献应在\s*(\d+)\s*篇以上/u.exec(text)
    if (references?.[1] !== undefined) {
      rules.push(makeRule(documentId, node, 'reference-count', `参考文献不少于 ${references[1]} 篇`, 'error', {
        minimum: Number(references[1]),
      }))
    }
    if (/中文字体/u.test(text) && /宋体/u.test(text)) {
      rules.push(makeRule(documentId, node, 'font', '正文中文使用宋体', 'error', { target: 'body', eastAsia: '宋体' }))
      if (/标题用黑体/u.test(text)) {
        rules.push(makeRule(documentId, node, 'font', '各级标题使用黑体', 'error', { target: 'heading', eastAsia: '黑体' }))
      }
      if (/(?:新罗马|Times New Roman)/u.test(text)) {
        rules.push(makeRule(documentId, node, 'font', '数字和英文使用 Times New Roman', 'error', {
          target: 'body',
          latin: 'Times New Roman',
        }))
      }
    }
    const size = /^(节标题|条标题|款、项标题|正文)\s*(小?\d号)字/u.exec(text)
    if (size?.[1] !== undefined && size[2] !== undefined) {
      const target = sizeTarget(size[1])
      const points = chineseSizePoints(size[2])
      rules.push(makeRule(documentId, node, 'font-size', `${size[1]}使用${size[2]}字`, 'error', {
        target,
        sizeLabel: size[2],
        ...(points === undefined ? {} : { points }),
      }))
      const spacing = /段前\s*([\d.]+)\s*行，?段后\s*([\d.]+)\s*行/u.exec(text)
      if (spacing?.[1] !== undefined && spacing[2] !== undefined) {
        rules.push(makeRule(documentId, node, 'paragraph-spacing', `${size[1]}段落间距`, 'warning', {
          target,
          beforeLines: Number(spacing[1]),
          afterLines: Number(spacing[2]),
        }))
      }
    }
    if (/不要设置页眉/u.test(text)) {
      rules.push(makeRule(documentId, node, 'page-setup', '不设置页眉', 'error', { header: false }))
    }
  }
}

function makeRule(
  documentId: DocumentId,
  node: DocumentNode | undefined,
  kind: TemplateRuleKind,
  label: string,
  severity: TemplateRule['severity'],
  expected: unknown,
  scope?: string,
): TemplateRule {
  const officePath = node?.officePath ?? scope
  const description = node === undefined ? label : `${label}。来源：${compactLabel(node.text)}`
  return {
    id: TemplateRuleId(`rule-${digest(JSON.stringify({ documentId, kind, label, expected, officePath })).slice(0, 24)}`),
    kind,
    label,
    description,
    severity,
    ...(scope === undefined ? {} : { scope }),
    expected,
    evidence: node === undefined ? [] : [{
      documentId,
      nodeId: node.id,
      officePath: node.officePath,
      excerpt: node.text.slice(0, 240),
      source: kind === 'page-setup' ? 'page-setup' : isStyleRule(kind) ? 'style' : 'document',
    }],
    confidence: node === undefined ? 0.8 : 1,
    enabled: true,
  }
}

function deduplicateRules(rules: readonly TemplateRule[]): TemplateRule[] {
  return [...new Map(rules.map(rule => [rule.id, rule])).values()]
}

function isStyleRule(kind: TemplateRuleKind): boolean {
  return kind === 'font' || kind === 'font-size' || kind === 'paragraph-spacing'
}

function isInstruction(text: string): boolean {
  const trimmed = text.trim()
  return /^(?:说\s*明|填写说明|注意|要求|↑|（|\()/u.test(trimmed)
    || /(?:建议|字体、字号|不要设置页眉|只作为.*示范)/u.test(trimmed)
}

function isFixedText(text: string, usage: TemplateUsage): boolean {
  const compact = text.replaceAll(/\s+/gu, '')
  if (/哈尔滨工业大学/u.test(compact)) return true
  if (/硕士学位(?:论文)?(?:开题|中期)报告/u.test(compact)) return true
  if (usage === 'format-reference' && /^(?:摘要|Abstract|目录|参考文献|结论)$/u.test(compact)) return true
  return false
}

function isHeading(text: string, styleName: string | undefined): boolean {
  if (styleName?.toLowerCase().includes('heading') === true) return true
  const trimmed = text.trim()
  return /^(?:第\s*\d+\s*章|\d+(?:\.\d+)+\s+|摘\s*要$|Abstract$|目\s*录$|参考文献$|结\s*论$)/u.test(trimmed)
}

function sectionLabel(text: string): string {
  return text
    .replace(/^\d+(?:\.\d+)*[．.]?\s*/u, '')
    .replace(/[（(].*$/u, '')
    .trim()
}

function compactLabel(text: string): string {
  const compact = text.trim().replaceAll(/\s+/gu, ' ')
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}…`
}

function sizeTarget(label: string): string {
  if (label === '正文') return 'body'
  if (label === '节标题') return 'heading-1'
  if (label === '条标题') return 'heading-2'
  return 'heading-3'
}

function chineseSizePoints(label: string): number | undefined {
  const points: Record<string, number> = {
    '小3号': 15,
    '4号': 14,
    '小4号': 12,
  }
  return points[label]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
