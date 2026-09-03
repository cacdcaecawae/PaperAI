import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { modelStateFromConfigOptions } from '../src/index.ts'

describe('modelStateFromConfigOptions', () => {
  it('prefers ACP semantic model category and preserves provider grouping', () => {
    const options = [
      {
        type: 'select',
        id: 'model',
        name: 'Legacy selector',
        category: 'mode',
        currentValue: 'legacy',
        options: [{ value: 'legacy', name: 'Legacy' }],
      },
      {
        type: 'select',
        id: 'provider-model',
        name: 'Provider model',
        category: 'model',
        currentValue: ' beta ',
        options: [
          {
            group: 'stable',
            name: ' Stable ',
            options: [
              { value: ' alpha ', name: ' Alpha ', description: ' First model ' },
              { value: 'beta', name: '  ' },
              { value: 'beta', name: 'Duplicate ignored' },
              { value: '  ', name: 'Blank id ignored' },
            ],
          },
          {
            group: 'experimental',
            name: '  ',
            options: [{ value: 'gamma', name: 'Gamma', description: null }],
          },
        ],
      },
    ] satisfies SessionConfigOption[]

    expect(modelStateFromConfigOptions(options)).toEqual({
      configId: 'provider-model',
      currentModel: 'beta',
      models: [
        { id: 'alpha', name: 'Alpha', description: 'First model', group: 'Stable' },
        { id: 'beta', name: 'beta', group: 'Stable' },
        { id: 'gamma', name: 'Gamma', group: 'experimental' },
      ],
      switches: [],
    })
  })

  it('reads the thought_level effort selector and boolean switches beside the model', () => {
    const options = [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'gpt',
        options: [{ value: 'gpt', name: 'GPT' }, { value: 'mini', name: 'Mini' }],
      },
      {
        type: 'select',
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High', description: 'Deeper reasoning' },
          { value: 'high', name: 'Duplicate ignored' },
          { value: ' ', name: 'Blank ignored' },
        ],
      },
      {
        type: 'boolean',
        id: 'fast-mode',
        name: 'Fast mode',
        description: '1.5x speed, increased usage',
        category: 'model_config',
        currentValue: true,
      },
    ] satisfies SessionConfigOption[]

    const reasoning = {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'Deeper reasoning' }],
      defaultEffort: 'high',
    }
    expect(modelStateFromConfigOptions(options)).toEqual({
      configId: 'model',
      currentModel: 'gpt',
      models: [
        { id: 'gpt', name: 'GPT', reasoning },
        { id: 'mini', name: 'Mini', reasoning },
      ],
      effort: { configId: 'reasoning_effort', efforts: reasoning.efforts, current: 'high' },
      switches: [{
        configId: 'fast-mode', name: 'Fast mode', description: '1.5x speed, increased usage', enabled: true,
      }],
    })
  })

  it('keeps an effort selector whose current value is not advertised as unselected', () => {
    const options = [
      {
        type: 'select',
        id: 'effort',
        name: 'Effort',
        currentValue: 'default',
        options: [{ value: 'medium', name: 'Medium' }],
      },
    ] satisfies SessionConfigOption[]
    expect(modelStateFromConfigOptions(options)).toEqual({
      models: [],
      effort: { configId: 'effort', efforts: [{ id: 'medium', name: 'Medium' }] },
      switches: [],
    })
    expect(modelStateFromConfigOptions([{
      type: 'select', id: 'effort', name: 'Effort', currentValue: 'x', options: [{ value: ' ', name: 'Blank' }],
    }])).toEqual({ models: [], switches: [] })
  })

  it('falls back to the conventional model id when category metadata is absent', () => {
    const options = [
      {
        type: 'boolean',
        id: 'thinking',
        name: 'Thinking',
        currentValue: true,
      },
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        currentValue: 'm2',
        options: [
          { value: 'm1', name: 'Model One' },
          { value: 'm2', name: 'Model Two' },
        ],
      },
    ] satisfies SessionConfigOption[]

    expect(modelStateFromConfigOptions(options)).toEqual({
      configId: 'model',
      currentModel: 'm2',
      models: [
        { id: 'm1', name: 'Model One' },
        { id: 'm2', name: 'Model Two' },
      ],
      switches: [{ configId: 'thinking', name: 'Thinking', enabled: true }],
    })
  })

  it.each([undefined, null, []] as const)('returns an empty catalog without an ACP model selector', (options) => {
    expect(modelStateFromConfigOptions(options)).toEqual({ models: [], switches: [] })
  })
})
