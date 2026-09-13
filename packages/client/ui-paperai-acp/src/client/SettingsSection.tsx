/** Unified ACP directory and instance editor inside the existing settings shell. */

import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './brand-slot.ts'
import type { AcpSettingsState, ChannelDraft } from './controller.ts'
import type { AcpHistoryEntry, AcpManagementRequest } from '@paperai/agent-acp/diagnostic-types'
import css from './SettingsSection.module.css'

/** Host-backed observations and actions supplied by the ACP plugin. */
export interface AcpSettingsInjected {
  hooks: { acp: HostObservable<AcpSettingsState> }
  load: () => Promise<void>
  probe: (id?: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  edit: (id: string) => void
  updateDraft: (patch: Partial<ChannelDraft>) => void
  cancelEdit: () => void
  save: () => Promise<void>
  setDefault: (id: string) => Promise<void>
  manage: (id: string, action: AcpManagementRequest) => Promise<boolean>
  install: (id: string, action: 'install' | 'uninstall') => Promise<void>
  importHistory: (id: string, history: AcpHistoryEntry) => Promise<boolean>
}

/** Settings section owner and injected actions. */
export type AcpSettingsProps = PropsRuntime<'settings.section'>
  & PropsRenderSlots<'paperai.acp.channel.mark'>
  & InjectFace<AcpSettingsInjected> & PropsLocale<'paperai.acp'>

/** Render the complete channel directory without switching the active conversation. */
export function AcpSettingsSection({
  useAcp,
  load,
  probe,
  cancel,
  edit,
  updateDraft,
  cancelEdit,
  save,
  setDefault,
  manage,
  install,
  importHistory,
  close,
  renderSlot,
  t,
}: AcpSettingsProps) {
  const state = useAcp(value => value)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    id: string
    kind: 'install' | 'uninstall' | 'logout' | 'delete'
    sessionId?: string
  } | null>(null)
  const [historyCwd, setHistoryCwd] = useState('')
  const [routing, setRouting] = useState<{
    id: string
    providerId: string
    apiType: string
    baseUrl: string
    headers: string
    error: string | null
  } | null>(null)
  useEffect(() => {
    void load()
  }, [load])
  const draft = state.draft
  return (
    <section className={css.page} aria-label="Agent" aria-busy={state.loading}>
      <header><h2>Agent</h2><p className={css.note}>{t('intro')}</p></header>
      {!state.writable && !state.loading && <p className={css.note}>{t('readOnly')}</p>}
      <div className={css.group}>
        <div className={css.groupLabel}>
          <h3>{t('connectionGroup')}</h3>
          <span className={css.actions}>
            <Button variant="outline"
              type="button"
              disabled={state.loading}
              onClick={() => {
                void load()
              }}
            >{t('refresh')}</Button>
            <Button variant="outline"
              type="button"
              disabled={state.busy.length > 0}
              onClick={() => {
                void probe()
              }}
            >{t('probeAll')}</Button>
          </span>
        </div>
        {state.error !== null && (
          <div role="alert" className={css.error}>
            <p>{t('failureHint')}</p>
            <details><summary>{t('reason')}</summary><p>{state.error}</p></details>
            <Button variant="toolbar" disabled={state.loading} onClick={() => { void load() }}>{t('retry')}</Button>
          </div>
        )}
        <div className={css.card}>
          {state.entries.map((entry) => {
            const diagnostic = entry.diagnostic
            const nextCursor = state.management[entry.id]?.nextCursor
            const busy = state.busy.includes(entry.id) || entry.busy !== null
            const missing = entry.source !== 'remote' && entry.adapter === null
            const status = busy && entry.busy !== 'connecting'
              ? entry.busy === 'install'
                ? t('installing')
                : entry.busy === 'authenticate'
                  ? t('authenticating')
                  : entry.busy === 'probe'
                    ? t('probing')
                    : t('working')
              : missing
                ? t('missing')
                : diagnostic.status === 'ready'
                  ? t('ready')
                  : diagnostic.status === 'error'
                    ? t('failed')
                    : t('unchecked')
            const usage = !state.usageKnown
              ? t('usageUnknown')
              : entry.connected
                ? t('inUse')
                : entry.startup !== null
                  ? t('connecting')
                  : t('unused')
            return (
              <article key={entry.id}>
                <div className={css.row}>
                  <span className={css.mark} aria-hidden="true">
                    {renderSlot('paperai.acp.channel.mark', {
                      presetId: entry.id,
                      size: 20,
                    }, { entryKey: entry.id })}
                  </span>
                  <Button variant="outline"
                    type="button"
                    className={css.identity}
                    aria-expanded={expanded === entry.id}
                    onClick={() => {
                      setExpanded(expanded === entry.id ? null : entry.id)
                    }}
                  >
                    <span>
                      <strong>{entry.name}</strong>
                      {state.defaultProvider === entry.id && <span className={css.badge}>{t('default')}</span>}
                      {!entry.enabled && <span className={css.badge}>{t('disabled')}</span>}
                    </span>
                    <small>
                      {entry.host} · {entry.command} {entry.args.join(' ')}
                    </small>
                  </Button>
                  <div className={css.channelState}>
                    <span className={css.status} data-ready={status === t('ready')} data-error={status === t('failed')}>
                      {status}
                    </span>
                    <span className={css.status} data-ready={state.usageKnown && entry.connected}>
                      {usage}
                    </span>
                  </div>
                  <div className={css.actions}>
                    {busy ? (
                      <Button variant="outline"
                        type="button"
                        onClick={() => {
                          void cancel(entry.id)
                        }}
                      >{t('cancel')}</Button>
                    ) : (
                      <Button variant="outline"
                        type="button"
                        disabled={missing}
                        onClick={() => {
                          void probe(entry.id)
                        }}
                      >{t('probe')}</Button>
                    )}
                    <Button variant="outline"
                      type="button"
                      disabled={!state.writable}
                      onClick={() => {
                        edit(entry.id)
                      }}
                    >{t('configure')}</Button>
                  </div>
                </div>
                {expanded === entry.id && (
                  <div className={css.details}>
                    <dl>
                      <dt>{t('host')}</dt>
                      <dd>{entry.host}</dd>
                      <dt>CLI</dt>
                      <dd>{entry.cli ?? (entry.source === 'remote' ? t('remoteUnknown') : t('localMissing'))}</dd>
                      <dt>{t('diagnostic')}</dt>
                      <dd>
                        {status}
                        {status === t('ready') && (
                          <>
                            {' · '}
                            {diagnostic.stage === 'prompt' ? t('promptReady') : diagnostic.stage === 'session' ? t('sessionReady') : t('handshakeReady')}
                          </>
                        )}
                      </dd>
                      <dt>{t('usage')}</dt>
                      <dd>{t('usageHint')}</dd>
                      {entry.startup !== null && (
                        <>
                          <dt>{t('startup')}</dt>
                          <dd>
                            {(
                              {
                                spawn: t('spawn'),
                                initialize: t('handshake'),
                                load: t('resume'),
                                new: t('newSession'),
                                permissions: t('permissionsSync'),
                              } as Record<string, string>
                            )[entry.startup.stage] ?? entry.startup.stage}{' '}
                            · {entry.startup.elapsedMs} ms
                          </dd>
                        </>
                      )}
                      <dt>{t('adapter')}</dt>
                      <dd>{entry.adapter ?? t('notFound')}</dd>
                      <dt>{t('source')}</dt>
                      <dd>
                        {entry.source === 'remote'
                          ? t('remoteHost')
                          : entry.source === 'bundled'
                            ? t('bundled')
                            : entry.source === 'managed'
                              ? t('managed')
                              : t('customCommand')}
                      </dd>
                      <dt>{t('version')}</dt>
                      <dd>{t('adapterLabel')}{diagnostic.adapterVersion ?? '—'} · Agent {diagnostic.agentVersion ?? '—'}
                      </dd>
                      <dt>{t('lastCheck')}</dt>
                      <dd>
                        {diagnostic.checkedAt === null ? t('neverChecked') : new Date(diagnostic.checkedAt).toLocaleString()}
                        {diagnostic.elapsedMs === null ? '' : ` · ${diagnostic.elapsedMs} ms`}
                      </dd>
                      <dt>{t('login')}</dt>
                      <dd>
                        {entry.login ?? t('loginHint')}
                        {entry.documentation !== null && (
                          <>
                            {' '}
                            ·{' '}
                            <a href={entry.documentation} target="_blank" rel="noreferrer">{t('documentation')}</a>
                          </>
                        )}
                      </dd>
                    </dl>
                    <p className={css.note}>{t('probeHint')}</p>
                    {diagnostic.error !== null && (
                      <p role="alert" className={css.error}>
                        {diagnostic.error === 'authentication'
                          ? t('authError')
                          : diagnostic.error === 'timeout'
                            ? t('timeoutError')
                            : diagnostic.error === 'unavailable'
                              ? t('executableError')
                              : t('protocolError')}
                      </p>
                    )}
                    {diagnostic.models.length > 0 && (
                      <p>{t('recentModels')}{diagnostic.models.map(model => model.name).join('、')}</p>
                    )}
                    <div className={css.actions}>
                      {entry.installable && (
                        <Button variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirm({ id: entry.id, kind: 'install' })
                          }}
                        >
                          {entry.source === 'managed' ? t('updateInstall') : t('install')}
                        </Button>
                      )}
                      {entry.source === 'managed' && (
                        <Button variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirm({ id: entry.id, kind: 'uninstall' })
                          }}
                        >{t('uninstall')}</Button>
                      )}
                      {diagnostic.authMethods
                        ?.filter(method => method.type === 'agent')
                        .map(method => (
                          <Button variant="outline"
                            type="button"
                            key={method.id}
                            disabled={busy}
                            title={method.description ?? undefined}
                            onClick={() => {
                              void manage(entry.id, { kind: 'authenticate', methodId: method.id })
                            }}
                          >
                            {method.name}
                          </Button>
                        ))}
                      {diagnostic.capabilities?.logout && (
                        <Button variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirm({ id: entry.id, kind: 'logout' })
                          }}
                        >{t('logoutChannel')}</Button>
                      )}
                      {diagnostic.capabilities?.providers && (
                        <Button variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void manage(entry.id, { kind: 'providers' })
                          }}
                        >{t('providers')}</Button>
                      )}
                    </div>
                    {entry.output !== null && (
                      <details open={busy}>
                        <summary>{t('output')}</summary>
                        <pre>{entry.output}</pre>
                      </details>
                    )}
                    {diagnostic.capabilities?.list && (
                      <details>
                        <summary>{t('history')}</summary>
                        <div className={css.toolbar}>
                          <Input
                            aria-label={t('historyDirectory', { name: entry.name })}
                            value={historyCwd}
                            onChange={(event) => {
                              setHistoryCwd(event.target.value)
                            }}
                            placeholder={t('historyDirectoryHint')}
                          />
                          <Button variant="outline"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void manage(entry.id, {
                                kind: 'history',
                                ...(historyCwd.trim() === '' ? {} : { cwd: historyCwd.trim() }),
                              })
                            }}
                          >{t('readHistory')}</Button>
                        </div>
                        {state.management[entry.id]?.sessions?.map(session => (
                          <div className={css.history} key={session.sessionId}>
                            <div>
                              <strong>{session.title ?? session.sessionId}</strong>
                              <small>
                                {session.cwd} · {session.updatedAt ?? t('timeUnknown')}
                              </small>
                            </div>
                            <Button variant="outline"
                              type="button"
                              disabled={busy || !entry.enabled || diagnostic.capabilities?.load !== true}
                              onClick={() => {
                                void importHistory(entry.id, session).then((opened) => {
                                  if (opened) close()
                                })
                              }}
                            >{t('importHistory')}</Button>
                            {diagnostic.capabilities?.delete && (
                              <Button variant="outline"
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setConfirm({ id: entry.id, kind: 'delete', sessionId: session.sessionId })
                                }}
                              >{t('deleteHistory')}</Button>
                            )}
                          </div>
                        ))}
                        {nextCursor != null && (
                          <Button variant="outline"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void manage(entry.id, {
                                kind: 'history',
                                cursor: nextCursor,
                                ...(historyCwd.trim() === '' ? {} : { cwd: historyCwd.trim() }),
                              })
                            }}
                          >{t('loadMore')}</Button>
                        )}
                      </details>
                    )}
                    {state.management[entry.id]?.providers?.map(provider => (
                      <div className={css.history} key={provider.id}>
                        <div>
                          <strong>
                            {provider.id}
                            {provider.required ? t('required') : ''}
                          </strong>
                          <small>
                            {provider.current === null
                              ? t('disabled')
                              : `${provider.current.apiType} · ${provider.current.baseUrl}`}
                          </small>
                        </div>
                        <Button variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setRouting({
                              id: entry.id,
                              providerId: provider.id,
                              apiType: provider.current?.apiType ?? provider.supported[0] ?? '',
                              baseUrl: provider.current?.baseUrl ?? '',
                              headers: '{}',
                              error: null,
                            })
                          }}
                        >{t('settings')}</Button>
                        {!provider.required && provider.current !== null && (
                          <Button variant="outline"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void manage(entry.id, { kind: 'disable-provider', providerId: provider.id })
                            }}
                          >{t('disableProvider')}</Button>
                        )}
                      </div>
                    ))}
                    {diagnostic.capabilities !== undefined && (
                      <details>
                        <summary>{t('capabilities')}</summary>
                        <p>
                          {Object.entries(diagnostic.capabilities)
                            .filter(([, enabled]) => enabled)
                            .map(
                              ([name]) =>
                                ({
                                  load: t('loadHistory'),
                                  resume: t('resume'),
                                  list: t('historyList'),
                                  fork: t('fork'),
                                  close: t('closeSession'),
                                  delete: t('delete'),
                                  additionalDirectories: t('directories'),
                                  image: t('image'),
                                  audio: t('audio'),
                                  embeddedContext: t('resources'),
                                  mcpHttp: 'MCP HTTP',
                                  mcpSse: 'MCP SSE',
                                  providers: t('providerSettings'),
                                  logout: t('logout'),
                                })[name] ?? name,
                            )
                            .join(' · ') || t('basicCapabilities')}
                        </p>
                      </details>
                    )}
                  </div>
                )}
              </article>
            )
          })}
          {state.entries.length === 0 && <p className={css.note}>{state.loading ? t('loading') : t('empty')}</p>}
        </div>
      </div>
      <div className={css.group}>
        <div className={css.groupLabel}>{t('newSessionDefaults')}</div>
        <div className={css.card}>
          <label className={css.row}>
            <span className={css.fact}>
              <span>{t('defaultAgent')}</span>
              <span>{t('defaultHint')}</span>
            </span>
            <select
              value={state.defaultProvider}
              disabled={!state.writable}
              onChange={(event) => {
                void setDefault(event.target.value)
              }}
            >
              {state.entries
                .filter(entry => entry.enabled)
                .map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </div>
      <Modal
        open={confirm !== null}
        onClose={() => {
          setConfirm(null)
        }}
        title={t('confirmTitle')}
        closeLabel={t('cancelOperation')}
      >
        <p>
          {confirm?.id}：
          {confirm?.kind === 'install'
            ? t('installImpact')
            : confirm?.kind === 'uninstall'
              ? t('uninstallImpact')
              : confirm?.kind === 'logout'
                ? t('logoutImpact')
                : t('deleteImpact')}
        </p>
        <div className={css.actions}>
          <Button variant="outline"
            type="button"
            onClick={() => {
              setConfirm(null)
            }}
          >{t('cancel')}</Button>
          <Button variant="outline"
            type="button"
            onClick={() => {
              if (confirm === null) return
              if (confirm.kind === 'install' || confirm.kind === 'uninstall') void install(confirm.id, confirm.kind)
              else if (confirm.kind === 'logout') void manage(confirm.id, { kind: 'logout' })
              else if (confirm.sessionId !== undefined)
                void manage(confirm.id, { kind: 'delete', sessionId: confirm.sessionId })
              setConfirm(null)
            }}
          >{t('confirm')}</Button>
        </div>
      </Modal>
      <Modal
        open={routing !== null}
        onClose={() => {
          if (routing === null || !state.busy.includes(routing.id)) setRouting(null)
        }}
        title={t('routingTitle')}
        closeLabel={t('cancelRouting')}
      >
        {routing !== null && (
          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault()
              try {
                const headers: unknown = JSON.parse(routing.headers)
                if (
                  headers === null ||
                  typeof headers !== 'object' ||
                  Array.isArray(headers) ||
                  Object.values(headers).some(value => typeof value !== 'string')
                )
                  throw new Error(t('headersError'))
                if (state.busy.includes(routing.id)) return
                setRouting({ ...routing, error: null })
                void manage(routing.id, {
                  kind: 'set-provider',
                  providerId: routing.providerId,
                  apiType: routing.apiType,
                  baseUrl: routing.baseUrl,
                  headers: headers as Record<string, string>,
                }).then((ok) => { if (ok) setRouting(null) })
              } catch (error: unknown) {
                setRouting({ ...routing, error: String(error) })
              }
            }}
          >
            <p>{routing.providerId}{t('routingImpact')}</p>
            <fieldset disabled={state.busy.includes(routing.id)}>
              <label>{t('apiType')}<select
                value={routing.apiType}
                onChange={(event) => {
                  setRouting({ ...routing, apiType: event.target.value })
                }}
              >
                {state.management[routing.id]?.providers
                  ?.find(provider => provider.id === routing.providerId)
                  ?.supported.map(api => (
                    <option key={api}>{api}</option>
                  ))}
              </select>
              </label>
              <label>{t('apiUrl')}<Input
                required
                type="url"
                value={routing.baseUrl}
                onChange={(event) => {
                  setRouting({ ...routing, baseUrl: event.target.value })
                }}
              />
              </label>
              <label>{t('headers')}<textarea
                value={routing.headers}
                onChange={(event) => {
                  setRouting({ ...routing, headers: event.target.value })
                }}
                autoComplete="off"
              />
              </label>
            </fieldset>
            {routing.error !== null && <p role="alert">{routing.error}</p>}
            {state.error !== null && <p role="alert" className={css.error}>{state.error}</p>}
            <Button variant="primary" type="submit" disabled={state.busy.includes(routing.id)}>
              {t(state.busy.includes(routing.id) ? 'saving' : 'saveRouting')}
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        open={draft !== null}
        onClose={cancelEdit}
        title={t('editTitle')}
        description={t('editHint')}
        closeLabel={t('cancelEdit')}
        className={css.modal ?? ''}
      >
        {draft !== null && (
          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <fieldset disabled={state.saving}>
              <legend>{t('connectionGroup')}</legend>
              <div className={css.fields}>
                <label>{t('channelId')}<Input value={draft.id} readOnly />
                </label>
                <label>{t('name')}<Input
                  value={draft.name}
                  required
                  onChange={(event) => {
                    updateDraft({ name: event.target.value })
                  }}
                />
                </label>
                <label className={css.check}>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => {
                      updateDraft({ enabled: event.target.checked })
                    }}
                  />{t('enable')}</label>
              </div>
              <label>{t('command')}<Input
                value={draft.command}
                onChange={(event) => {
                  updateDraft({ command: event.target.value })
                }}
                placeholder={t('commandHint')}
              />
              </label>
              <label>{t('args')}<textarea
                rows={2}
                value={draft.args}
                onChange={(event) => {
                  updateDraft({ args: event.target.value })
                }}
                spellCheck={false}
              />
              </label>
              <details>
                <summary>{t('ssh')}</summary>
                <label>{t('sshConfig')}<textarea
                  rows={4}
                  value={draft.ssh}
                  onChange={(event) => {
                    updateDraft({ ssh: event.target.value })
                  }}
                  placeholder={'{"host":"research-server","cwd":"/home/me/project"}'}
                  spellCheck={false}
                />
                </label>
                <p className={css.note}>{t('sshHint')}</p>
              </details>
              <h3>{t('credentialsGroup')}</h3>
              <div className={css.fields}>
                {(draft.template === 'codex' || draft.template === 'claude') && (
                  <>
                    <label>
                      API Key
                      <Input
                        type="password"
                        autoComplete="off"
                        value={draft.apiKey}
                        disabled={draft.clearKey}
                        onChange={(event) => {
                          updateDraft({ apiKey: event.target.value })
                        }}
                        placeholder={t('retainCredentials')}
                      />
                    </label>
                    <label>
                      Base URL
                      <Input
                        value={draft.baseURL}
                        onChange={(event) => {
                          updateDraft({ baseURL: event.target.value })
                        }}
                        placeholder={t('channelDefault')}
                      />
                    </label>
                  </>
                )}
                <label>{t('proxy')}<Input
                  value={draft.proxy}
                  onChange={(event) => {
                    updateDraft({ proxy: event.target.value })
                  }}
                  placeholder={t('proxyHint')}
                />
                </label>
              </div>
              <details>
                <summary>{t('advanced')}</summary>
                <label>{t('env')}<textarea
                  rows={3}
                  value={draft.env}
                  disabled={draft.clearEnv}
                  onChange={(event) => {
                    updateDraft({ env: event.target.value })
                  }}
                  placeholder={t('envHint')}
                  spellCheck={false}
                />
                </label>
                <div className={css.fields}>
                  <label className={css.check}>
                    <input
                      type="checkbox"
                      checked={draft.clearKey}
                      onChange={(event) => {
                        updateDraft({ clearKey: event.target.checked })
                      }}
                    />{t('clearKey')}</label>
                  <label className={css.check}>
                    <input
                      type="checkbox"
                      checked={draft.clearEnv}
                      onChange={(event) => {
                        updateDraft({ clearEnv: event.target.checked })
                      }}
                    />{t('clearEnv')}</label>
                </div>
              </details>
              <details>
                <summary>{t('modelsGroup')}</summary>
                <label>{t('model')}<Input
                  value={draft.model}
                  onChange={(event) => {
                    updateDraft({ model: event.target.value })
                  }}
                  list="acp-known-models"
                  placeholder={t('modelHint')}
                />
                </label>
                <datalist id="acp-known-models">
                  {state.entries
                    .find(entry => entry.id === draft.id)
                    ?.diagnostic.models.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                </datalist>
                <label>{t('reasoning')}<Input
                  value={draft.reasoningEffort}
                  onChange={(event) => {
                    updateDraft({ reasoningEffort: event.target.value })
                  }}
                  placeholder={t('reasoningHint')}
                />
                </label>
                <label>{t('options')}<textarea
                  rows={3}
                  value={draft.configOptions}
                  onChange={(event) => {
                    updateDraft({ configOptions: event.target.value })
                  }}
                  spellCheck={false}
                />
                </label>
                <label>{t('permissions')}<textarea
                  rows={3}
                  value={draft.permissionModes}
                  onChange={(event) => {
                    updateDraft({ permissionModes: event.target.value })
                  }}
                  placeholder={'{"read-only":"…","workspace-write":"…","danger-full-access":"…"}'}
                  spellCheck={false}
                />
                </label>
                <p className={css.note}>{t('permissionsHint')}</p>
              </details>
              <details>
                <summary>{t('preferences')}</summary>
                <label>{t('language')}<Input
                  value={draft.language}
                  onChange={(event) => {
                    updateDraft({ language: event.target.value })
                  }}
                  placeholder={t('languageHint')}
                />
                </label>
                <label>{t('instructions')}<textarea
                  rows={4}
                  value={draft.personalPrompt}
                  onChange={(event) => {
                    updateDraft({ personalPrompt: event.target.value })
                  }}
                  placeholder={t('instructionsHint')}
                />
                </label>
              </details>
            </fieldset>
            {!draft.enabled && state.defaultProvider === draft.id && (
              <p className={css.note}>{t('disableDefault')}</p>
            )}
            {state.draftError !== null && (
              <p role="alert" className={css.error}>
                {state.draftError}
              </p>
            )}
            <footer className={css.actions}>
              <Button variant="outline" type="button" disabled={state.saving} onClick={cancelEdit}>{t('cancel')}</Button>
              <Button variant="primary" type="submit" disabled={state.saving || !state.writable}>
                {state.saving ? t('saving') : t('save')}
              </Button>
            </footer>
          </form>
        )}
      </Modal>
    </section>
  )
}
