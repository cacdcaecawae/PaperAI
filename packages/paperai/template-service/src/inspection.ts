/** Validation of OfficeCLI inspection values used by template compilation and checks. */

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
