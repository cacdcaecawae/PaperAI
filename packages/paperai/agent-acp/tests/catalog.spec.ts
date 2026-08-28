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
    })
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
    })
  })

  it.each([undefined, null, []] as const)('returns an empty catalog without an ACP model selector', (options) => {
    expect(modelStateFromConfigOptions(options)).toEqual({ models: [] })
  })
})
