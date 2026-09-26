/** PaperAI's own document tools as one quiet row: a state dot, the action in words, the input and result on demand. */

import { useState, type ReactNode } from 'react'
import { Button, DisclosureRow, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { AcpKey, AcpTranslate } from './locales.ts'
import css from './AcpToolRow.module.css'

/** Transcript tool name the Host gives PaperAI's own MCP tool calls; mirrors `PAPERAI_TOOL` in `@paperai/agent-acp`. */
export const PAPERAI_TOOL = 'paperai_document_tool'

/** Full row props: the toolview runtime share plus this plugin's locale seat. */
export type AcpToolRowProps = ToolCallViewProps & PropsLocale<'paperai.acp'>

type RowState = 'running' | 'ok' | 'error'

const TOOL_KEYS = {
  paperai_list_projects: 'tool.listProjects',
  paperai_list_documents: 'tool.listDocuments',
  paperai_read_document: 'tool.readDocument',
  paperai_list_templates: 'tool.listTemplates',
  paperai_get_template: 'tool.getTemplate',
  paperai_list_versions: 'tool.listVersions',
  paperai_check_gate: 'tool.checkGate',
  paperai_prepare_export: 'tool.prepareExport',
  paperai_commit_document: 'tool.commitDocument',
  paperai_revert_document: 'tool.revertDocument',
  paperai_export_document: 'tool.exportDocument',
} as const satisfies Record<string, AcpKey>

const DOTS: Record<RowState, StateDotState> = { running: 'ongoing', ok: 'done', error: 'error' }
/** The state a reader hears before the row; a completed call needs no announcement. */
const STATE_KEYS: Record<RowState, AcpKey | null> = { running: 'tool.running', ok: null, error: 'tool.failed' }

/** Failure codes PaperAI's own server raises, in words; mirrors `ToolFailure` in `@paperai/mcp`. An unlisted code reads its own message. */
const FAILURE_KEYS = {
  DOCUMENT_NOT_FOUND: 'fail.documentNotFound',
  TEMPLATE_NOT_FOUND: 'fail.templateNotFound',
  TEMPLATE_NOT_CONFIRMED: 'fail.templateNotConfirmed',
  TEMPLATE_ROLE_INCOMPATIBLE: 'fail.templateRoleIncompatible',
  INVALID_REQUEST: 'fail.invalidRequest',
  DELIVERY_BLOCKED: 'fail.deliveryBlocked',
  INVALID_EXPORT_PROVENANCE: 'fail.invalidExportProvenance',
} as const satisfies Record<string, AcpKey>

/** The tool's own name at the end of a provider name or title: `mcp__paperai__paperai_read_document` → `paperai_read_document`. */
const OWN_NAME = /paperai_[a-z]+(?:_[a-z]+)*$/u

interface Display {
  readonly tool: string | null
  readonly title: string
  readonly input: unknown
  readonly output: string
}

function readDisplay(raw: string | undefined): Display {
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw === undefined ? {} : JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) value = parsed as Record<string, unknown>
  } catch {
    // A truncated argument string reads as an empty call; the row still shows its state.
  }
  const name = typeof value.name === 'string' ? value.name : ''
  const title = typeof value.title === 'string' ? value.title : ''
  return {
    tool: OWN_NAME.exec(name)?.[0] ?? OWN_NAME.exec(title)?.[0] ?? null,
    title,
    input: value.input,
    output: typeof value.output === 'string' ? value.output : '',
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The text parts of an MCP result envelope (`{ content: [{ type: 'text', text }], isError }`), or `null` for anything else. */
function unwrapEnvelope(record: Record<string, unknown>): string | null {
  if (!Array.isArray(record.content)) return null
  return record.content
    .flatMap((part: unknown) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
      ? [(part as { text: string }).text]
      : []))
    .join('\n')
}

/** What the tool itself wrote: the Host records the provider's whole result envelope, and people read its text parts. */
function readableOutput(output: string): string {
  const record = parseObject(output.trim())
  return (record === null ? null : unwrapEnvelope(record)) ?? output
}

/** One failure field: a plain line, or the `{ code, message }` envelope PaperAI's own MCP server nests there. */
function failureLine(candidate: unknown, t: AcpTranslate): string | null {
  if (typeof candidate === 'string') return candidate === '' ? null : candidate
  if (typeof candidate !== 'object' || candidate === null) return null
  const { code, message } = candidate as { code?: unknown; message?: unknown }
  const key = typeof code === 'string' ? (FAILURE_KEYS as Record<string, AcpKey | undefined>)[code] : undefined
  if (key !== undefined) return t(key)
  return typeof message === 'string' && message !== '' ? message : null
}

/** The line a failed call is remembered by: the JSON detail when the tool wrote one, else the first line of plain text. */
function failureOf(output: string, t: AcpTranslate): string | null {
  const text = readableOutput(output).trim()
  if (text === '') return null
  const record = parseObject(text)
  if (record === null) return text.split('\n')[0] ?? null
  for (const key of ['detail', 'message', 'error']) {
    const line = failureLine(record[key], t)
    if (line !== null) return line
  }
  // A structure without a readable line stays behind the disclosure rather than being dumped into the row.
  return null
}

/** Render one PaperAI tool call as a row keyed on the Host's PaperAI tool name. */
export function AcpToolRow({ toolName, block, inspect, t }: AcpToolRowProps): ReactNode {
  // A settled node carries its kind; the running form has none.
  const result = 'kind' in block ? block : null
  const display = readDisplay('kind' in block ? block.call?.argsRaw : block.argsRaw)
  const output = readableOutput(result === null
    ? display.output
    : result.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n') || display.output)
  const state: RowState = result === null ? 'running' : result.isError ? 'error' : 'ok'
  const key = display.tool === null ? undefined : (TOOL_KEYS as Record<string, AcpKey | undefined>)[display.tool]
  const title = key === undefined ? (display.tool ?? display.title) : t(key)
  const failure = state === 'error' ? failureOf(output, t) : null
  // A provider title that only repeats the tool name adds nothing beside the reading.
  const summary = failure ?? (display.title !== '' && !OWN_NAME.test(display.title) ? display.title : null)
  const input = display.input === undefined ? null : JSON.stringify(display.input, null, 2)
  const expandable = input !== null || output !== ''
  const [open, setOpen] = useState(false)
  const stateKey = STATE_KEYS[state]
  return (
    <div className={css.card} data-tool={toolName} data-state={state}>
      {stateKey !== null && <span className={css.visuallyHidden}>{t(stateKey)}</span>}
      <DisclosureRow
        rowClassName={css.row}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<StateDot state={DOTS[state]} />}
        title={title}
        open={open && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={summary === null ? undefined : (
          <span className={failure === null ? css.summary : css.failure}>{summary}</span>
        )}
      >
        <div className={css.body}>
          {input !== null && (
            <section>
              <h4>{t('tool.input')}</h4>
              <pre>{input}</pre>
            </section>
          )}
          {output !== '' && (
            <section>
              <h4>{t('tool.output')}</h4>
              <pre>{output}</pre>
            </section>
          )}
          {inspect !== undefined && (
            <Button variant="ghost" size="sm" onClick={inspect}>{t('tool.inspect')}</Button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
