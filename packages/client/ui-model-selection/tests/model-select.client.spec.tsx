// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    switches: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect driver switches', () => {
  it('renders driver switches as checkable rows and submits one flipped value with the selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'codex', model: 'gpt', reasoningEffort: 'high', switches: { 'fast-mode': false } },
      groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt', name: 'GPT', reasoning }] }],
      switches: [{ id: 'fast-mode', name: 'Fast mode', description: '1.5x speed, increased usage', enabled: false }],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((s) => {
        s.current = selection
        s.switches = s.switches.map(entry => ({ ...entry, enabled: selection.switches?.[entry.id] === true }))
      })
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 GPT，推理等级 High' })
    expect(trigger.textContent).toBe('GPTHigh')
    fireEvent.click(trigger)
    const fast = screen.getByRole('menuitemcheckbox', { name: /Fast mode/ })
    expect(fast.getAttribute('aria-checked')).toBe('false')
    expect(fast.getAttribute('title')).toBe('1.5x speed, increased usage')
    fast.focus()
    fireEvent.click(fast)

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'codex', model: 'gpt', reasoningEffort: 'high', switches: { 'fast-mode': true },
      })
    })
    // The menu stays open so the switch reads back in place; the trigger caption follows,
    // and focus returns to the row the busy state disabled.
    const flipped = screen.getByRole('menuitemcheckbox', { name: /Fast mode/ })
    expect(flipped.getAttribute('aria-checked')).toBe('true')
    expect(trigger.textContent).toBe('GPTHigh · Fast mode')
    await waitFor(() => { expect(document.activeElement).toBe(flipped) })
    fireEvent.keyDown(flipped, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('announces a rejected switch through the selection toast', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'codex', model: 'gpt', switches: { fast: true } },
      groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt', name: 'GPT' }] }],
      switches: [{ id: 'fast', name: 'Fast mode', enabled: true }],
    }))
    const select = vi.fn(async () => {
      directory.update((s) => { s.status = 'error'; s.error = 'select' })
      return false
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型，当前 GPT' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fast mode/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt', switches: { fast: false } })
    })
    expect(await screen.findByText('未能切换模型，请重试。')).not.toBeNull()
  })
})

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'select' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('未能切换模型，请重试。')
    expect(toast.textContent).not.toContain('model-unavailable')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('keeps whole-request and provider diagnostics out of load failure surfaces', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      status: 'error',
      error: 'load',
      failures: [{ id: 'codex', name: 'Codex', message: 'resume failed: Internal error' }],
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.getByRole('alert').textContent).toContain('暂时无法加载模型列表，请重试。')
    expect(screen.getByRole('status').textContent).toContain('暂时无法加载 Codex 的模型。')
    expect(document.body.textContent).not.toContain('resume failed')
    expect(document.body.textContent).not.toContain('Internal error')
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
