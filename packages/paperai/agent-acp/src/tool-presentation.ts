/** Pure presentation of provider-owned calls through the shared DSH tool cards. */

import { z } from 'zod'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'

/** Driver-owned presentation name; this registration never exposes an executable tool. */
export const ACP_TOOL = 'paperai_acp_tool'

/** Validated durable display fields retained with each complete tool argument update. */
export const AcpToolDisplaySchema = z.object({
  name: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.string(),
  input: z.unknown(),
  output: z.string(),
  truncated: z.boolean(),
  diffs: z.array(z.object({ path: z.string(), oldText: z.string().nullable(), newText: z.string() })),
  locations: z.array(z.object({ path: z.string(), line: z.number().optional() })),
})

/** Current provider arguments and bounded display content for a tool call. */
export type AcpToolDisplay = z.infer<typeof AcpToolDisplaySchema>

/**
 * Render one complete pending snapshot without consulting a live connection.
 * @param args - durable display fields from the ACP event projection.
 * @returns generic progress or inline file diff presentation.
 */
export function presentAcpCall(args: unknown): ToolCallView {
  const value = AcpToolDisplaySchema.parse(args)
  const locations = value.locations.map(location => ({
    path: location.path,
    ...(location.line === undefined ? {} : { line: location.line }),
  }))
  if (value.diffs.length > 0) return { card: 'diff', title: value.title, diffs: value.diffs, locations }
  return {
    card: 'generic',
    title: value.title,
    rawInput: value.input,
    locations,
    content:
      value.output === '' ? [] : [{ type: 'text', text: value.output + (value.truncated ? '\n[输出已截断]' : '') }],
  }
}

/**
 * Render the completed provider snapshot using the existing diff, terminal, or generic card.
 * @param args - last durable call/progress arguments.
 * @returns result presentation independent of the provider process lifetime.
 */
export function presentAcpResult(args: unknown): ToolResultView {
  const value = AcpToolDisplaySchema.parse(args)
  const output = value.output + (value.truncated ? '\n[输出已截断]' : '')
  if (value.diffs.length > 0) return { card: 'diff', title: value.title, diffs: value.diffs }
  if (value.kind === 'execute') return { card: 'terminal', title: value.title, output }
  return {
    card: 'generic',
    title: value.title,
    content: [{ type: 'text', text: output }],
  }
}
