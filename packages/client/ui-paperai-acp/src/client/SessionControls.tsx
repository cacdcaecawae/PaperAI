/** Provider-owned options and connection feedback in the existing conversation header. */
import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AcpSessionControlState } from './session-controller.ts'
import type { AcpSettingsState } from './controller.ts'
import css from './SettingsSection.module.css'

/** Runtime-bound controls and shared instance preferences. */
export interface AcpSessionInjected {
  hooks: { acpSession: HostObservable<AcpSessionControlState>; acpPreferences: HostObservable<AcpSettingsState> }
  load: () => Promise<void>
  select: (option: string, value: string | boolean) => Promise<void>
  favorite: (provider: string, model: string) => Promise<void>
}

/** ACP contribution to a single conversation's header. */
export type AcpSessionProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<AcpSessionInjected> & PropsLocale<'paperai.acp'>

/**
 * Show the current Agent's advertised options and recoverable connection state.
 * @param props - Owning session, locale and injected controls.
 * @returns Options entry, or no entry for a loaded native DSH session.
 */
export function AcpSessionControls({
  sessionId, useSessions, useAcpSession, useAcpPreferences, load, select, favorite, t,
}: AcpSessionProps) {
  const state = useAcpSession(value => value)
  const preferences = useAcpPreferences(value => value)
  const preset = useSessions(value => value.byId[sessionId]?.agentPreset)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [customModel, setCustomModel] = useState('')
  useEffect(() => {
    setOpen(false)
    setQuery('')
    setCustomModel('')
    void load()
  }, [load, preset])
  const details = preset === undefined || state.details?.provider === preset ? state.details : null
  if (details === null) {
    if (!state.loading && state.error === null) return null
    return <div className={css.sessionFeedback} role="status">
      <span>{t(state.loading ? 'sessionLoading' : 'sessionFailed')}</span>
      {!state.loading && <Button variant="toolbar" title={state.error ?? undefined} onClick={() => { void load() }}>
        {t('retry')}
      </Button>}
    </div>
  }
  const favorites = preferences.favorites[details.provider] ?? []
  const locked = state.loading || state.busy || !details.connected
  const status = t(state.busy ? 'applying' : state.loading ? 'sessionLoading' : details.connected ? 'connected' : 'disconnected')
  return <>
    <Button variant="toolbar" className={css.sessionButton}
      aria-label={t('sessionTitle', { name: details.name })} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setOpen(true); void load() }}>
      {status} · {t('sessionOptions')}
    </Button>
    <Modal open={open} onClose={() => { setOpen(false) }}
      title={t('sessionDialog', { name: details.name })} closeLabel={t('sessionClose')} className={css.modal ?? ''}>
      <div className={css.form} aria-busy={state.loading || state.busy}>
        <p className={css.note}>{t('sessionHint')}</p>
        <div className={css.toolbar}>
          <span role="status" aria-live="polite">{status}</span>
          <Button variant="outline" disabled={state.loading || state.busy} onClick={() => { void load() }}>
            {t('sessionRefresh')}
          </Button>
        </div>
        {!details.connected && <p className={css.note}>{t('reconnectHint')}</p>}
        {state.error !== null && <div role="alert" className={css.error}>
          <p>{t('failureHint')}</p>
          <details><summary>{t('reason')}</summary><p>{state.error}</p></details>
        </div>}
        {preferences.error !== null && <p role="alert" className={css.error}>{preferences.error}</p>}
        {details.options.map(option => option.category === 'model' ? (
          <section key={option.id} aria-label={option.name}>
            <label>{option.name}
              <Input aria-label={t('searchModels')} placeholder={t('searchHint')} value={query}
                onChange={(event) => { setQuery(event.target.value) }} />
            </label>
            <div className={css.models}>
              {[...option.choices]
                .sort((a, b) => Number(favorites.includes(b.value)) - Number(favorites.includes(a.value)))
                .filter(choice => `${choice.name} ${choice.value}`.toLowerCase().includes(query.toLowerCase()))
                .map(choice => <div className={css.history} key={choice.value}>
                  <Button variant="toolbar" disabled={locked || !option.editable}
                    aria-pressed={option.value === choice.value}
                    onClick={() => { void select(option.id, choice.value) }}>
                    {option.value === choice.value ? '✓ ' : ''}{choice.name}<small>{choice.value}</small>
                  </Button>
                  <Button variant="toolbar" disabled={!preferences.writable}
                    aria-label={t(favorites.includes(choice.value) ? 'unfavorite' : 'favorite', { name: choice.name })}
                    onClick={() => { void favorite(details.provider, choice.value) }}>
                    {favorites.includes(choice.value) ? '★' : '☆'}
                  </Button>
                </div>)}
              {!option.choices.some(choice => `${choice.name} ${choice.value}`.toLowerCase().includes(query.toLowerCase()))
                && <p role="status" className={css.note}>{t('noModels')}</p>}
            </div>
            <form className={css.toolbar} onSubmit={(event) => {
              event.preventDefault()
              if (!locked && option.editable && customModel.trim() !== '') void select(option.id, customModel.trim())
            }}>
              <Input aria-label={t('customModel')} value={customModel} placeholder={t('customHint')}
                onChange={(event) => { setCustomModel(event.target.value) }} />
              <Button variant="outline" type="submit" disabled={locked || !option.editable || customModel.trim() === ''}>
                {t('applyModel')}
              </Button>
            </form>
          </section>
        ) : (
          <label key={option.id} className={typeof option.value === 'boolean' ? css.check : undefined}>
            <span>{option.name}</span>
            {typeof option.value === 'boolean' ? (
              <input type="checkbox" disabled={locked || !option.editable} checked={option.value}
                onChange={(event) => { void select(option.id, event.target.checked) }} />
            ) : (
              <select disabled={locked || !option.editable} value={option.value}
                onChange={(event) => { void select(option.id, event.target.value) }}>
                {!option.choices.some(choice => choice.value === option.value) && <option>{option.value}</option>}
                {option.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
              </select>
            )}
            <small>{option.editable ? option.description : t('permissionOwned')}</small>
          </label>
        ))}
        {details.state.usage !== null && <p>{t('context', { used: details.state.usage.used, size: details.state.usage.size })}
          {details.state.usage.cost !== null && t('cost', { amount: details.state.usage.cost.amount, currency: details.state.usage.cost.currency })}
        </p>}
        <details><summary>{t('sessionDetails')}</summary>
          <p>{t('externalSession', { id: details.externalSessionId ?? t('notEstablished') })}</p>
          {details.state.stopReason !== null && <p>{t('stopReason', { reason: details.state.stopReason })}</p>}
        </details>
        {details.state.plans.map(plan => <details key={plan.id}>
          <summary>{t('plan', { id: plan.id })}</summary>
          {plan.text !== '' && <pre>{plan.text}</pre>}
          <ul>{plan.entries.map((entry, index) => <li key={index}>
            {entry.status === 'completed' ? '✓ ' : entry.status === 'in_progress' ? t('inProgress') : ''}{entry.content}
          </li>)}</ul>
        </details>)}
        {details.state.compactions.map(compaction => <details key={compaction.id}>
          <summary>{t('compaction', { status: compaction.status })}</summary>
          {compaction.error !== null && <p role="alert">{compaction.error}</p>}
          <pre>{compaction.summary}</pre>
        </details>)}
        {details.state.commands.length > 0 && <details>
          <summary>{t('commands')}</summary><p>{t('commandsHint')}</p>
          <ul>{details.state.commands.map(command => <li key={command.name}>/{command.name} · {command.description}</li>)}</ul>
        </details>}
      </div>
    </Modal>
  </>
}
