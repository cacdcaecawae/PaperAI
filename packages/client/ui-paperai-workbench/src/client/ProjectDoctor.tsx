/** Read-only project integrity report and explicit recoverable repair actions. */

import { useState } from 'react'
import { Button, IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectCheckState } from './diagnostics-controller.ts'
import type { PaperAIDocumentId, PaperAIWorkingRecoveryPlan } from './types.ts'
import type { PaperAIWorkbenchKey } from './locales.ts'
import css from './Diagnostics.module.css'

/** Render diagnostics only after the user opens the project check. */
export function ProjectDoctor({ state, inspect, capture, t }: {
  state: ProjectCheckState | undefined
  inspect: (plan?: PaperAIWorkingRecoveryPlan) => Promise<void>
  capture: (documentId: PaperAIDocumentId) => Promise<void>
  t: (key: PaperAIWorkbenchKey) => string
}) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<PaperAIWorkingRecoveryPlan | null>(null)
  return (
    <div className={css.doctor}>
      <button type="button" className={css.row} aria-expanded={open} onClick={() => {
        setOpen(value => !value)
        if (!open && state?.report == null) void inspect()
      }}><IconChecklistOutline14 />{t('doctor.title')}</button>
      {open && <section aria-label={t('doctor.title')} className={css.report}>
        <p>{t('doctor.description')}</p>
        <Button variant="outline" size="sm" disabled={state?.busy} onClick={() => { setPlan(null); void inspect() }}>
          {t(state?.busy === true ? 'doctor.scanning' : 'doctor.scan')}
        </Button>
        {state?.error != null && <p role="alert">{t('doctor.failed')}</p>}
        {state?.report != null && <>
          {state.report.issues.length === 0 && <p role="status">{t('doctor.healthy')}</p>}
          <ul>{state.report.issues.map((issue, index) => <li key={index}>
            <strong>{t(`doctor.issue.${issue.code}`)}</strong>
            <span className={css.path}>{issue.path.replaceAll('\\', '/')}</span>
            {issue.code === 'working-changed' && <Button variant="outline" size="sm" disabled={state.busy}
              onClick={() => { void capture(issue.documentId) }}>{t('doctor.capture')}</Button>}
          </li>)}</ul>
          {state.report.repairs.map(repair => <Button key={repair.documentId} variant="outline" size="sm"
            disabled={state.busy} onClick={() => { setPlan(repair) }}>{t('doctor.plan')} · {repair.workingPath.split(/[\\/]/u).at(-1)}</Button>)}
        </>}
        {plan !== null && <div className={css.repair} role="region" aria-label={t('doctor.plan')}>
          <strong>{t('doctor.restoreDescription')}</strong>
          <span className={css.path}>{plan.workingPath.replaceAll('\\', '/')}</span>
          <span className={css.path}>{plan.headCommitId}</span>
          <Button variant="outline" size="sm" disabled={state?.busy} onClick={() => { void inspect(plan).then(() => { setPlan(null) }) }}>{t('doctor.restore')}</Button>
          <Button variant="toolbar" size="sm" onClick={() => { setPlan(null) }}>{t('doctor.cancel')}</Button>
        </div>}
      </section>}
    </div>
  )
}
