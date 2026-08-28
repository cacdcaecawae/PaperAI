import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import type { AgentDriverModel } from '@deepseek-ai/dsh-agent'

/** Normalized model selector from one ACP session. */
export interface AcpModelState {
  readonly configId?: string
  readonly models: readonly AgentDriverModel[]
  readonly currentModel?: string
}

function text(value: string | null | undefined): string | undefined {
  const clean = value?.trim()
  return clean === '' ? undefined : clean
}

function isGroup(
  option: SessionConfigSelectOption | SessionConfigSelectGroup,
): option is SessionConfigSelectGroup {
  return 'options' in option && Array.isArray(option.options)
}

/**
 * Read ACP's semantic model selector without inventing a provider model list.
 * @param configOptions Session configuration advertised by the ACP provider.
 * @returns The normalized selector, or an empty model list when no model selector is advertised.
 */
export function modelStateFromConfigOptions(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): AcpModelState {
  const selectors = (configOptions ?? []).filter(option => option.type === 'select')
  const model = selectors.find(option => option.category === 'model')
    ?? selectors.find(option => option.id === 'model')
  if (model === undefined) return { models: [] }

  const models: AgentDriverModel[] = []
  const seen = new Set<string>()
  const append = (option: SessionConfigSelectOption, group?: string): void => {
    const id = text(option.value)
    if (id === undefined || seen.has(id)) return
    seen.add(id)
    const description = text(option.description)
    models.push({
      id,
      name: text(option.name) ?? id,
      ...description === undefined ? {} : { description },
      ...group === undefined ? {} : { group },
    })
  }
  for (const option of model.options) {
    if (isGroup(option)) {
      const group = text(option.name) ?? text(option.group)
      for (const child of option.options) append(child, group)
    } else {
      append(option)
    }
  }
  const currentModel = text(model.currentValue)
  return {
    configId: model.id,
    models,
    ...currentModel === undefined ? {} : { currentModel },
  }
}
