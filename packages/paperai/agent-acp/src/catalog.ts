import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import type { AgentDriverModel, AgentDriverReasoningEffort } from '@deepseek-ai/dsh-agent'

/** ACP's semantic reasoning-effort selector (`thought_level`) for the current model. */
export interface AcpEffortState {
  /** Config option id used to apply an effort through `session/set_config_option`. */
  readonly configId: string
  /** Advertised efforts in provider order. */
  readonly efforts: readonly AgentDriverReasoningEffort[]
  /** Currently applied effort, when the provider reports one. */
  readonly current?: string
}

/** One boolean session option the provider advertises, such as Codex or Claude fast mode. */
export interface AcpSwitchState {
  /** Config option id used to apply the switch through `session/set_config_option`. */
  readonly configId: string
  /** Provider display name. */
  readonly name: string
  /** Optional provider description, including why the switch is unavailable. */
  readonly description?: string
  /** Whether the provider reports the switch as on. */
  readonly enabled: boolean
}

/** Normalized model, effort, and switch selectors from one ACP session. */
export interface AcpModelState {
  readonly configId?: string
  readonly models: readonly AgentDriverModel[]
  readonly currentModel?: string
  /** Reasoning-effort selector for the current model, when advertised. */
  readonly effort?: AcpEffortState
  /** Boolean session switches in provider order. */
  readonly switches: readonly AcpSwitchState[]
}

const EFFORT_OPTION_IDS = new Set(['effort', 'reasoning_effort', 'reasoning-effort'])

function text(value: string | null | undefined): string | undefined {
  const clean = value?.trim()
  return clean === '' ? undefined : clean
}

function isGroup(
  option: SessionConfigSelectOption | SessionConfigSelectGroup,
): option is SessionConfigSelectGroup {
  return 'options' in option && Array.isArray(option.options)
}

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

function flatten(select: SelectOption): readonly { option: SessionConfigSelectOption; group?: string }[] {
  const rows: { option: SessionConfigSelectOption; group?: string }[] = []
  for (const option of select.options) {
    if (isGroup(option)) {
      const group = text(option.name) ?? text(option.group)
      for (const child of option.options) rows.push(group === undefined ? { option: child } : { option: child, group })
    } else {
      rows.push({ option })
    }
  }
  return rows
}

function effortState(select: SelectOption): AcpEffortState | undefined {
  const efforts: AgentDriverReasoningEffort[] = []
  const seen = new Set<string>()
  for (const { option } of flatten(select)) {
    const id = text(option.value)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const description = text(option.description)
    efforts.push({ id, name: text(option.name) ?? id, ...description === undefined ? {} : { description } })
  }
  if (efforts.length === 0) return undefined
  const current = text(select.currentValue)
  return {
    configId: select.id,
    efforts,
    ...current !== undefined && seen.has(current) ? { current } : {},
  }
}

/**
 * Read ACP's semantic model, reasoning-effort, and boolean switch selectors
 * without inventing a provider vocabulary. Efforts are advertised for the
 * current model, so every model carries the same effort list until the
 * provider re-advertises after a model switch.
 * @param configOptions Session configuration advertised by the ACP provider.
 * @returns The normalized selectors, or empty lists when nothing relevant is advertised.
 */
export function modelStateFromConfigOptions(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): AcpModelState {
  const options = configOptions ?? []
  const selectors = options.filter((option): option is SelectOption => option.type === 'select')
  const switches: AcpSwitchState[] = []
  for (const option of options) {
    if (option.type !== 'boolean') continue
    const description = text(option.description)
    switches.push({
      configId: option.id,
      name: text(option.name) ?? option.id,
      ...description === undefined ? {} : { description },
      enabled: option.currentValue,
    })
  }
  const effortSelect = selectors.find(option => option.category === 'thought_level')
    ?? selectors.find(option => EFFORT_OPTION_IDS.has(option.id))
  const effort = effortSelect === undefined ? undefined : effortState(effortSelect)
  const model = selectors.find(option => option.category === 'model')
    ?? selectors.find(option => option.id === 'model')
  if (model === undefined) return { models: [], ...effort === undefined ? {} : { effort }, switches }

  const reasoning = effort === undefined
    ? undefined
    : { efforts: effort.efforts, ...effort.current === undefined ? {} : { defaultEffort: effort.current } }
  const models: AgentDriverModel[] = []
  const seen = new Set<string>()
  for (const { option, group } of flatten(model)) {
    const id = text(option.value)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const description = text(option.description)
    models.push({
      id,
      name: text(option.name) ?? id,
      ...description === undefined ? {} : { description },
      ...group === undefined ? {} : { group },
      ...reasoning === undefined ? {} : { reasoning },
    })
  }
  const currentModel = text(model.currentValue)
  return {
    configId: model.id,
    models,
    ...currentModel === undefined ? {} : { currentModel },
    ...effort === undefined ? {} : { effort },
    switches,
  }
}
