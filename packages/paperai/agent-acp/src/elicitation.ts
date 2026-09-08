/** ACP form elicitation projected through the existing DSH user-questions capability. */

import { CreateElicitationRequest, ElicitationPropertySchema, MultiSelectItems, type CreateElicitationResponse, type ElicitationPropertySchema as Property, type EnumOption } from '@agentclientprotocol/sdk'
import { fromJSONSchema } from 'zod'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

type FormValue = string | number | boolean | string[]

function choices(property: Property): { label: string; value: FormValue }[] {
  if (ElicitationPropertySchema.isBoolean(property)) return [{ label: '是', value: true }, { label: '否', value: false }]
  let titled: readonly EnumOption[] = []
  let values: readonly string[] = []
  if (ElicitationPropertySchema.isString(property)) {
    titled = property.oneOf ?? []
    values = property.enum ?? []
  } else if (ElicitationPropertySchema.isArray(property)) {
    if (MultiSelectItems.isString(property.items)) values = property.items.enum
    else if (MultiSelectItems.isTitled(property.items)) titled = property.items.anyOf
  }
  return titled.length > 0
    ? titled.map(option => ({ label: `${option.title} (${option.const})`, value: option.const }))
    : values.map(value => ({ label: value, value }))
}

/**
 * Ask for typed form values, validating user input against the provider's JSON Schema.
 * @param request - wire-validated ACP form request.
 * @param ask - owning DSH question provider with its lifecycle cancellation already bound.
 * @param signal - cancellation for the owning ACP request and active turn.
 * @returns accepted typed values, explicit decline, or cancellation.
 */
export async function elicitForm(
  request: CreateElicitationRequest,
  ask: (questions: AskUserQuestionItem[]) => Promise<AskUserQuestionAnswer>,
  signal: AbortSignal,
): Promise<CreateElicitationResponse> {
  if (!CreateElicitationRequest.isForm(request)) return { action: 'decline' }
  const fields = Object.entries(request.requestedSchema.properties ?? {})
  if (fields.some(([, property]) => ElicitationPropertySchema.isCustom(property))) return { action: 'decline' }
  const schema = fromJSONSchema(JSON.parse(JSON.stringify(
    { ...request.requestedSchema, type: 'object' },
    (key, value: unknown) => key === '_meta' || value === null ? undefined : value,
  )) as Parameters<typeof fromJSONSchema>[0])
  let issue = ''
  const cancelled = (): boolean => signal.aborted
  while (!cancelled()) {
    const questions = fields.map(([id, property]): AskUserQuestionItem => ({
      id, question: `${request.message}\n${typeof property.title === 'string' ? property.title : id}`,
      detail: [property.description, issue].filter(Boolean).join('\n'),
      options: choices(property).map(({ label }) => ({ label })),
      multiSelect: ElicitationPropertySchema.isArray(property),
    }))
    if (questions.length === 0) return schema.safeParse({}).success ? { action: 'accept', content: {} } : { action: 'decline' }
    let answered: AskUserQuestionAnswer
    try { answered = await ask(questions) }
    catch (error: unknown) { if (cancelled()) return { action: 'cancel' }; throw error }
    if (cancelled()) return { action: 'cancel' }
    if (answered.answers.length === 0) return { action: 'decline' }
    const content: Record<string, FormValue> = {}
    for (const [id, property] of fields) {
      const answer = answered.answers.find(entry => entry.id === id)
      if (answer === undefined) continue
      const selected = answer.selected.map(label => choices(property).find(option => option.label === label)?.value ?? label)
      const custom = answer.custom
      if (ElicitationPropertySchema.isArray(property)) {
        content[id] = [...selected.map(String), ...custom ? [custom] : []]
      } else if (custom !== undefined && (!(ElicitationPropertySchema.isNumber(property) || ElicitationPropertySchema.isInteger(property)) || custom.trim() !== '')) {
        content[id] = ElicitationPropertySchema.isNumber(property) || ElicitationPropertySchema.isInteger(property)
          ? Number(custom) : custom
      } else if (selected[0] !== undefined) content[id] = selected[0]
    }
    const parsed = schema.safeParse(content)
    if (parsed.success) return { action: 'accept', content }
    issue = parsed.error.issues.map(entry => `${entry.path.join('.')}: ${entry.message}`).join('\n')
  }
  return { action: 'cancel' }
}
