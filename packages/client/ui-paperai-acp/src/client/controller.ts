/** ACP settings actions over the shared settings mirror and Host-owned channel directory. */

import { createSnapshotStore, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@paperai/workbench-service/remote'
import type { AcpConfig, AcpProviderConfig } from '@paperai/agent-acp/src/providers.ts'
import type {
  AcpCatalogEntry,
  AcpHistoryEntry,
  AcpManagementRequest,
  AcpManagementResult,
} from '@paperai/agent-acp/diagnostic-types'

/** The generated ACP management methods, independent of document editing. */
export type AcpRemote = Pick<
  TypertClientRemote['paperaiWorkbench'],
  'acpCatalog' | 'acpCancel' | 'probeAgent' | 'acpManage' | 'acpInstall' | 'acpLinkedSession' | 'acpImportHistory'
>

/** Editable channel fields; blank secret inputs preserve stored values unless explicitly cleared. */
export interface ChannelDraft {
  id: string
  template: string
  name: string
  enabled: boolean
  command: string
  args: string
  env: string
  apiKey: string
  clearKey: boolean
  clearEnv: boolean
  baseURL: string
  proxy: string
  model: string
  reasoningEffort: string
  configOptions: string
  permissionModes: string
  language: string
  personalPrompt: string
  ssh: string
}

/** One ACP settings page snapshot. */
export interface AcpSettingsState {
  entries: readonly AcpCatalogEntry[]
  /** Whether the Host has supplied session usage since the last connection or refresh failure. */
  usageKnown: boolean
  loading: boolean
  error: string | null
  busy: readonly string[]
  defaultProvider: string
  writable: boolean
  draft: ChannelDraft | null
  saving: boolean
  draftError: string | null
  management: Readonly<Record<string, AcpManagementResult>>
  favorites: Readonly<Record<string, readonly string[]>>
}

const NS = 'paperai-acp-agents'

function jsonRecord(source: string, field: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field}须为 JSON 对象`)
  return parsed as Record<string, unknown>
}

/** Channel editing and directory refresh live here; renderers only dispatch gestures. */
export class AcpSettingsController {
  /** Shared channel observations and unsaved editor state. */
  readonly store = createSnapshotStore<AcpSettingsState>({
    entries: [],
    usageKnown: false,
    loading: false,
    error: null,
    busy: [],
    defaultProvider: 'codex',
    writable: false,
    draft: null,
    saving: false,
    draftError: null,
    management: {},
    favorites: {},
  })
  private generation = 0
  private disposed = false
  private readonly stop: () => void
  private writes = Promise.resolve()
  private readonly historyDirectories = new Map<string, string | undefined>()

  constructor(
    private readonly remote: AcpRemote,
    private readonly api: Pick<IApiClient, 'settings'>,
    private readonly settings: SettingsDescribeFace,
    private readonly navigation: {
      create: (options: { cwd: string; agentPreset: string }) => Promise<SessionId>
      open: (id: SessionId) => void
      localDirectory: () => string | undefined
    },
  ) {
    this.stop = settings.subscribe(() => {
      this.readSettings()
    })
    this.readSettings()
  }

  private readSettings(): void {
    const snapshot = this.settings.getSnapshot()
    const defaultView = snapshot.view?.namespaces.find(entry => entry.ns === 'agent-presets')
    const value = defaultView?.value as { default?: string } | undefined
    const config = snapshot.view?.namespaces.find(entry => entry.ns === NS)?.value as AcpConfig | undefined
    this.store.update((state) => {
      state.writable = snapshot.view?.writable === true
      state.defaultProvider = value?.default ?? 'codex'
      state.favorites = Object.fromEntries(
        Object.entries(config?.providers ?? {}).map(([id, settings]) => [id, settings.favoriteModels ?? []]),
      )
    })
  }

  /**
   * Refresh installation observations; superseded responses cannot replace a newer directory.
   * @param clearError - whether an explicit refresh clears the previous operation error.
   */
  async load(clearError = true): Promise<void> {
    if (this.isDisposed()) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.loading = true
      if (clearError) state.error = null
    })
    try {
      await this.settings.ensure()
      const result = await this.remote.acpCatalog()
      if (this.isDisposed() || generation !== this.generation) return
      if (!result.ok) throw new Error(result.error.message)
      this.store.update((state) => {
        state.entries = result.value
        state.usageKnown = true
      })
    } catch (error: unknown) {
      if (!this.isDisposed() && generation === this.generation)
        this.store.update((state) => {
          state.error = String(error)
          state.usageKnown = false
          state.entries = state.entries.map(entry => ({ ...entry, connected: false }))
        })
    } finally {
      if (!this.isDisposed() && generation === this.generation)
        this.store.update((state) => {
          state.loading = false
        })
    }
  }

  /**
   * Probe one channel or the full directory without creating model turns.
   * @param id - one instance, or undefined for all enabled/discovered channels.
   */
  async probe(id?: string): Promise<void> {
    const entries = this.store
      .getSnapshot()
      .entries.filter(entry => (id === undefined ? entry.enabled || entry.adapter !== null : entry.id === id))
    await Promise.all(
      entries.map(async (entry) => {
        if (this.store.getSnapshot().busy.includes(entry.id)) return
        this.store.update((state) => {
          state.busy = [...state.busy, entry.id]
        })
        try {
          const result = await this.remote.probeAgent({ provider: entry.id, force: true })
          if (!result.ok && !this.isDisposed())
            this.store.update((state) => {
              state.error = result.error.message
            })
        } catch (error: unknown) {
          if (!this.isDisposed())
            this.store.update((state) => {
              state.error = String(error)
            })
        } finally {
          if (!this.isDisposed())
            this.store.update((state) => {
              state.busy = state.busy.filter(value => value !== entry.id)
            })
        }
      }),
    )
    if (!this.isDisposed()) await this.load(false)
  }

  /**
   * Cancel a queued or running Host operation.
   * @param id - channel owning the operation.
   */
  async cancel(id: string): Promise<void> {
    try {
      const result = await this.remote.acpCancel({ provider: id })
      if (!result.ok) throw new Error(result.error.message)
    } catch (error: unknown) {
      if (!this.isDisposed())
        this.store.update((state) => {
          state.error = String(error)
        })
    }
  }

  /**
   * Run account, routing, or history actions with channel-owned progress.
   * @param id - configured instance id.
   * @param action - user-selected management action.
   */
  async manage(id: string, action: AcpManagementRequest): Promise<void> {
    await this.operation(id, async () => {
      if (action.kind === 'history' && action.cursor !== undefined && this.historyDirectories.get(id) !== action.cwd)
        throw new Error('工作目录已改变，请重新读取历史')
      const result = await this.remote.acpManage({ provider: id, action })
      if (!result.ok) throw new Error(result.error.message)
      if (this.isDisposed()) return
      if (action.kind === 'history') this.historyDirectories.set(id, action.cwd)
      this.store.update((state) => {
        const previous = state.management[id]
        const sessions =
          action.kind === 'history' && action.cursor !== undefined
            ? [
              ...new Map(
                [...(previous?.sessions ?? []), ...(result.value.sessions ?? [])].map(session => [
                  session.sessionId,
                  session,
                ]),
              ).values(),
            ]
            : result.value.sessions
        state.management = {
          ...state.management,
          [id]: { ...previous, ...result.value, ...(sessions === undefined ? {} : { sessions }) },
        }
        if (action.kind === 'delete')
          state.management = {
            ...state.management,
            [id]: {
              ...state.management[id],
              sessions: previous?.sessions?.filter(session => session.sessionId !== action.sessionId) ?? [],
            },
          }
      })
      if (action.kind === 'set-provider' || action.kind === 'disable-provider') {
        const refreshed = await this.remote.acpManage({ provider: id, action: { kind: 'providers' } })
        if (!refreshed.ok) throw new Error(refreshed.error.message)
        if (!this.isDisposed())
          this.store.update((state) => {
            state.management = { ...state.management, [id]: { ...state.management[id], ...refreshed.value } }
          })
      }
    })
  }

  /**
   * Change a channel's managed installation without changing its credentials.
   * @param id - configured instance id.
   * @param action - install/update or uninstall.
   */
  async install(id: string, action: 'install' | 'uninstall'): Promise<void> {
    await this.operation(id, async () => {
      const result = await this.remote.acpInstall({ provider: id, action })
      if (!result.ok) throw new Error(result.error.message)
    })
  }

  /**
   * Open a known local import or create a new conversation for the selected provider history.
   * @param id - selected ACP channel.
   * @param history - provider-returned session identity and directory.
   * @returns whether a local conversation was opened successfully.
   */
  async importHistory(id: string, history: AcpHistoryEntry): Promise<boolean> {
    let opened = false
    await this.operation(id, async () => {
      const linked = await this.remote.acpLinkedSession({ provider: id, externalSessionId: history.sessionId })
      if (!linked.ok) throw new Error(linked.error.message)
      if (linked.value !== null) {
        if (!this.isDisposed()) {
          this.navigation.open(linked.value)
          opened = true
        }
        return
      }
      const remoteHost = this.store.getSnapshot().entries.find(entry => entry.id === id)?.source === 'remote'
      const cwd = remoteHost ? this.navigation.localDirectory() : history.cwd
      if (cwd === undefined) throw new Error('导入远程历史前请先打开一个本地论文项目')
      const created = await this.navigation.create({ cwd, agentPreset: id })
      const imported = await this.remote.acpImportHistory({
        sessionId: created,
        externalSessionId: history.sessionId,
        cwd: history.cwd,
      })
      if (!imported.ok) throw new Error(imported.error.message)
      if (!this.isDisposed()) {
        this.navigation.open(imported.value)
        opened = true
      }
    })
    return opened
  }

  private async operation(id: string, run: () => Promise<void>): Promise<void> {
    if (this.isDisposed() || this.store.getSnapshot().busy.includes(id)) return
    this.store.update((state) => {
      state.busy = [...state.busy, id]
      state.error = null
    })
    let reading = false
    const progress = setInterval(() => {
      if (reading || this.isDisposed()) return
      reading = true
      void this.load(false).finally(() => {
        reading = false
      })
    }, 1000)
    try {
      await run()
    } catch (error: unknown) {
      if (!this.isDisposed())
        this.store.update((state) => {
          state.error = String(error)
        })
    } finally {
      clearInterval(progress)
      if (!this.isDisposed()) {
        this.store.update((state) => {
          state.busy = state.busy.filter(value => value !== id)
        })
        await this.load(false)
      }
    }
  }

  /**
   * Open a channel editor over the current redacted settings snapshot.
   * @param id - existing Codex or Claude channel.
   */
  edit(id: string): void {
    if (this.isDisposed() || !this.store.getSnapshot().entries.some(entry => entry.id === id)) return
    const view = this.settings.getSnapshot().view?.namespaces.find(entry => entry.ns === NS)
    // This namespace's Host schema owns these fields; secret fields are absent in its wire view.
    const config = view?.value as AcpConfig | undefined
    const entry = this.store.getSnapshot().entries.find(row => row.id === id)
    const value: AcpProviderConfig = config?.providers?.[id] ?? {}
    this.store.update((state) => {
      state.draftError = null
      state.draft = {
        id,
        template: entry?.template ?? id,
        name: value.name ?? entry?.name ?? '',
        enabled: entry?.enabled ?? true,
        command: value.command ?? '',
        args: JSON.stringify(value.args ?? entry?.args ?? [], null, 2),
        env: '',
        apiKey: '',
        clearKey: false,
        clearEnv: false,
        baseURL: value.baseURL ?? '',
        proxy: value.proxy ?? '',
        model: value.model ?? '',
        reasoningEffort: value.reasoningEffort ?? '',
        configOptions: JSON.stringify(value.configOptions ?? {}, null, 2),
        permissionModes: JSON.stringify(value.permissionModes ?? {}, null, 2),
        language: value.language ?? '',
        personalPrompt: value.personalPrompt ?? '',
        ssh: value.ssh === undefined ? '' : JSON.stringify(value.ssh, null, 2),
      }
    })
  }

  /**
   * Update one draft field without changing the Host configuration.
   * @param patch - fields edited by the user.
   */
  updateDraft(patch: Partial<ChannelDraft>): void {
    this.store.update((state) => {
      if (state.draft === null || state.saving) return
      state.draft = { ...state.draft, ...patch, id: state.draft.id, template: state.draft.template }
    })
  }

  /** Discard an unsaved form. */
  cancelEdit(): void {
    this.store.update((state) => {
      if (!state.saving) {
        state.draft = null
        state.draftError = null
      }
    })
  }

  private mutate(ns: string, ops: SettingsPathOpView[] | (() => SettingsPathOpView[])): Promise<void> {
    const write = this.writes.then(async () => {
      if (this.isDisposed()) return
      const revision = this.settings.getSnapshot().view?.namespaces.find(entry => entry.ns === ns)?.revision
      const result = await this.api.settings.mutate({
        ns,
        ops: typeof ops === 'function' ? ops() : ops,
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      })
      if (!result.result.ok) throw new Error(result.result.error.message)
      this.settings.acceptView(result.result.value)
    })
    this.writes = write.catch(() => {
      /* The caller displays a rejected settings write; later writes may retry. */
    })
    return write
  }

  /**
   * Select the default Agent for subsequent conversations.
   * @param id - enabled ACP instance or the native DSH Agent.
   */
  async setDefault(id: string): Promise<void> {
    try {
      await this.mutate('agent-presets', [{ op: 'set', path: ['default'], value: id }])
    } catch (error: unknown) {
      if (!this.isDisposed())
        this.store.update((state) => {
          state.error = String(error)
        })
    }
  }

  /**
   * Toggle a model favorite for exactly one configured ACP instance.
   * @param provider - stable instance identity.
   * @param model - provider model id.
   */
  async favorite(provider: string, model: string): Promise<void> {
    try {
      await this.mutate(NS, () => {
        const current = this.store.getSnapshot().favorites[provider] ?? []
        const value = current.includes(model) ? current.filter(id => id !== model) : [...current, model]
        return [{ op: 'set', path: ['providers', provider, 'favoriteModels'], value }]
      })
    } catch (error: unknown) {
      if (!this.isDisposed())
        this.store.update((state) => {
          state.error = String(error)
        })
    }
  }

  /** Persist the form using path mutations that preserve unseen stored credentials. */
  async save(): Promise<void> {
    const draft = this.store.getSnapshot().draft
    if (draft === null || this.store.getSnapshot().saving) return
    this.store.update((state) => {
      state.saving = true
      state.draftError = null
    })
    try {
      const args: unknown = JSON.parse(draft.args)
      if (!Array.isArray(args) || args.some(value => typeof value !== 'string'))
        throw new Error('启动参数须为 JSON 字符串数组')
      const values: Record<string, unknown> = {
        template: draft.template,
        name: draft.name,
        enabled: draft.enabled,
        args,
        configOptions: jsonRecord(draft.configOptions, '会话选项'),
        permissionModes: jsonRecord(draft.permissionModes, '权限模式'),
      }
      for (const field of [
        'command',
        'baseURL',
        'proxy',
        'model',
        'reasoningEffort',
        'language',
        'personalPrompt',
      ] as const)
        values[field] = draft[field] || undefined
      values.ssh = draft.ssh.trim() === '' ? undefined : jsonRecord(draft.ssh, 'SSH 配置')
      const ops: SettingsPathOpView[] = Object.entries(values).map(([field, value]) =>
        value === undefined
          ? { op: 'unset', path: ['providers', draft.id, field] }
          : { op: 'set', path: ['providers', draft.id, field], value },
      )
      if (draft.clearKey) ops.push({ op: 'unset', path: ['providers', draft.id, 'apiKey'] })
      else if (draft.apiKey !== '')
        ops.push({ op: 'set', path: ['providers', draft.id, 'apiKey'], value: draft.apiKey })
      if (draft.clearEnv) ops.push({ op: 'unset', path: ['providers', draft.id, 'env'] })
      else if (draft.env !== '')
        ops.push({ op: 'set', path: ['providers', draft.id, 'env'], value: jsonRecord(draft.env, '环境变量') })
      if (!draft.enabled && this.store.getSnapshot().defaultProvider === draft.id)
        throw new Error('请先更换默认 Agent，再停用此渠道')
      await this.mutate(NS, ops)
      if (this.isDisposed()) return
      this.store.update((state) => {
        state.draft = null
      })
      await this.load()
    } catch (error: unknown) {
      if (!this.isDisposed())
        this.store.update((state) => {
          state.draftError = String(error)
        })
    } finally {
      if (!this.isDisposed())
        this.store.update((state) => {
          state.saving = false
        })
    }
  }

  /** Clear live connection claims as soon as the Host transport disconnects. */
  disconnected(): void {
    this.generation += 1
    this.store.update((state) => {
      state.loading = false
      state.usageKnown = false
      state.entries = state.entries.map(entry => ({ ...entry, connected: false }))
    })
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  /** Stop subscriptions and ignore outstanding read results. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.stop()
  }
}
