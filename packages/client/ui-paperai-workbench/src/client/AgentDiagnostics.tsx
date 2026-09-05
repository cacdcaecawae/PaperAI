/** Provider-owned readiness and cached model previews beside the Agent selector. */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type { DiagnosticsState } from './diagnostics-controller.ts'
import css from './Diagnostics.module.css'

/** Narrow observer and actions supplied by the workbench registration. */
export interface AgentDiagnosticsInjected {
  hooks: { diagnostics: HostObservable<DiagnosticsState> }
  loadAgents: () => Promise<void>
  probe: (provider: 'codex' | 'claude', force: boolean) => Promise<void>
}

/** Slot-derived readiness props. */
export type AgentDiagnosticsProps = PropsRuntime<'conversation.hero.agentPreset.status'>
  & PropsLocale<'paperai.workbench'> & InjectFace<AgentDiagnosticsInjected>

/** Render cached metadata as a preview; the live model selector remains authoritative. */
export function AgentDiagnostics({ presetId, connecting, useDiagnostics, loadAgents, probe, t }: AgentDiagnosticsProps) {
  const state = useDiagnostics(value => value)
  const [open, setOpen] = useState(false)
  useEffect(() => { void loadAgents() }, [presetId, connecting, loadAgents])
  const provider = presetId === 'codex' || presetId === 'claude' ? presetId : undefined
  if (provider === undefined) return null
  const metadata = state.agents.find(agent => agent.provider === provider)
  const probing = state.probing.includes(provider)
  return (
    <span className={css.agent}>
      <button type="button" className={css.trigger} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {t('agent.details')}
      </button>
      {open && <span className={css.popover} role="region" aria-label={t('agent.details')}>
        <strong>{provider === 'codex' ? 'Codex' : 'Claude'}</strong>
        {metadata !== undefined && <>
          <span>{t('agent.adapter')} {metadata.adapterVersion ?? '—'} · {metadata.agentVersion ?? '—'}</span>
          <span>{t(metadata.status === 'ready' ? 'agent.ready' : metadata.status === 'discovered' ? 'agent.discovered' : 'agent.failed')}</span>
          {metadata.error !== null && <span role="alert">{t(`agent.error.${metadata.error}`)}</span>}
          {metadata.checkedAt !== null && <span>{new Date(metadata.checkedAt).toLocaleString()}</span>}
          {metadata.retryAt !== null && <span>{t('agent.cooldown')} {new Date(metadata.retryAt).toLocaleTimeString()}</span>}
          {metadata.models.length > 0 && <>
            <strong>{t('agent.cachedModels')}</strong>
            <span>{metadata.models.map(model => model.name).join(' · ')}</span>
          </>}
        </>}
        {state.agentError !== null && <span role="alert">{state.agentError}</span>}
        <button type="button" className={css.trigger} disabled={connecting || probing} onClick={() => { void probe(provider, true) }}>
          {t(probing ? 'agent.probing' : 'agent.probe')}
        </button>
      </span>}
    </span>
  )
}
