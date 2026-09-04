/** The three panels that open beside the document: template, gate, versions. */

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, DisclosureRow, IconCheckOutline14, IconChecklistOutline14, IconChevronDownOutline14,
  IconCloseOutline16, IconWarningOutline16, Menu, Pill, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PaperAIDocumentSnapshot, PaperAIDocumentType, PaperAIDocumentVersion, PaperAIGateFinding,
  PaperAIProjectOverview, PaperAIVersionChange, PaperAIWorkbenchState,
} from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import { DOCUMENT_TYPE_KEYS, DOCUMENT_TYPE_ORDER, USAGE_KEYS, type PaperAIWorkbenchKey } from './locales.ts'
import css from './DocumentWorkbench.module.css'

type Translate = PaperAIDocumentWorkbenchProps['t']

/** Panel chrome shared by the three panels: a titled header with a close control and a scrolling body. */
export function Panel({ title, onClose, children, t }: {
  title: string
  onClose: () => void
  children: ReactNode
  t: Translate
}): ReactNode {
  return (
    <aside className={css.panel} aria-label={title}>
      <div className={css.panelHeader}>
        <h2>{title}</h2>
        <button type="button" className={css.panelClose} aria-label={t('panel.close')} onClick={onClose}>
          <IconCloseOutline16 />
        </button>
      </div>
      <div className={css.panelBody}>{children}</div>
    </aside>
  )
}

/** Composer draft asking the session agent to clear the failing findings. */
export function fixPromptText(document: PaperAIDocumentSnapshot, t: Translate): string {
  const failing = document.gate.findings.filter(finding => !finding.passed)
  const lines = failing.slice(0, 8).map((finding, index) => `${index + 1}. ${finding.title}：${finding.message}`)
  return [t('gate.fixPrompt', { count: failing.length }), ...lines].join('\n')
}

/** Browser-local date formatting; the Host retains the exact ISO timestamp. */
function versionDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date)
}

/** Ledger badge id for one version author; drives the badge accent. */
function actorClient(version: PaperAIDocumentVersion): string {
  if (version.actor.kind !== 'agent') return 'human'
  const client = version.actor.client
  return client === undefined || client === '' ? 'agent' : client
}

/** Ledger badge text: the author identity, then the exact model when known. */
function actorBadge(version: PaperAIDocumentVersion, t: Translate): string {
  const client = actorClient(version)
  const name = client === 'human'
    ? t('actor.human')
    : client === 'dsh'
      ? 'DSH'
      : client === 'codex' ? 'Codex' : client === 'claude' ? 'Claude' : version.actor.name
  const model = version.actor.kind === 'agent' ? version.actor.model : undefined
  return model === undefined || model === '' ? name : `${name} · ${model}`
}

function FindingRow({ finding, t }: { finding: PaperAIGateFinding; t: Translate }): ReactNode {
  return (
    <li className={css.finding} data-passed={finding.passed ? 'true' : 'false'} data-severity={finding.severity}>
      <span className={css.findingIcon} aria-hidden="true">
        {finding.passed ? <IconCheckOutline14 /> : <IconWarningOutline16 size={14} />}
      </span>
      <div>
        <strong>{finding.title}</strong>
        <p>{finding.message}</p>
        {finding.location !== undefined && <span>{t('gate.location', { location: finding.location })}</span>}
      </div>
    </li>
  )
}

/** Template panel: the bound format and its requirements, plus applying the project template. */
export function TemplatePanel({
  document, state, overview, applyTemplate, detachTemplate, suggestType, changeProject, onClose, t,
}: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  overview: PaperAIProjectOverview | null
  applyTemplate: PaperAIDocumentWorkbenchProps['applyTemplate']
  detachTemplate: PaperAIDocumentWorkbenchProps['detachTemplate']
  suggestType: PaperAIDocumentWorkbenchProps['suggestType']
  changeProject: () => void
  onClose: () => void
  t: Translate
}): ReactNode {
  const busy = state.action !== null
  const projectFormats = overview?.template?.formats ?? []
  const available = DOCUMENT_TYPE_ORDER.filter(type => projectFormats.some(format => format.documentType === type))
  const suggested = state.typeSuggestion?.documentType
  const initial = suggested !== undefined && available.includes(suggested)
    ? suggested
    : available.includes(document.documentType) ? document.documentType : available[0]
  const [chosen, setChosen] = useState<PaperAIDocumentType | undefined>(initial)
  const [typeOpen, setTypeOpen] = useState(false)
  useEffect(() => { setChosen(initial) }, [initial])
  // Ask once what the document looks like, so the type chooser starts on the likely answer.
  useEffect(() => {
    if (document.template === null && state.typeSuggestion === null && state.action === null) void suggestType()
  }, [document.template, state.typeSuggestion, state.action, suggestType])
  const [requirementsOpen, setRequirementsOpen] = useState(false)
  const template = document.template
  // The Host's guess, while it is still the chooser's value: the caption says where the default came from.
  const guessedType = state.typeSuggestion !== null && state.typeSuggestion.basis !== 'current'
    && state.typeSuggestion.documentType === chosen
    ? chosen
    : undefined
  const chosenFormat = projectFormats.find(format => format.documentType === chosen)
  // Match the provenance fields that identify one pack member version. A set
  // switch or an in-place format replacement must remain applicable.
  const reboundFromSameFormat = template !== null
    && chosen === document.documentType
    && template.packId === overview?.template?.packId
    && template.memberId === chosenFormat?.memberId
    && template.sourceVersion === chosenFormat?.sourceVersion
  const canApply = chosen !== undefined && !reboundFromSameFormat

  return (
    <Panel title={t('template.title')} onClose={onClose} t={t}>
      {template === null
        ? <p className={css.panelNote}>{t('template.none')}</p>
        : (
          <div className={css.templateCurrent}>
            <div className={css.templateHeading}>
              <strong>{template.name}</strong>
              <Pill>{t(USAGE_KEYS[template.usage])}</Pill>
            </div>
            <span className={css.panelCaption}>
              {template.packName ?? ''}{template.packName === undefined ? '' : ' · '}
              {t('template.type', { type: t(DOCUMENT_TYPE_KEYS[document.documentType]) })}
            </span>
            <DisclosureRow
              className={css.requirements}
              icon={<IconChecklistOutline14 />}
              title={t('template.requirements', { count: template.requirements.length })}
              open={requirementsOpen}
              expandable
              expandOnRowClick
              onToggle={() => { setRequirementsOpen(open => !open) }}
            >
              {template.requirements.length === 0
                ? <p className={css.panelNote}>{t('template.noRequirements')}</p>
                : (
                  <ul className={css.requirementList}>
                    {template.requirements.map(requirement => (
                      <li key={requirement.ruleId} data-enabled={requirement.enabled ? 'true' : 'false'}>
                        <StateDot
                          state={requirement.severity === 'error' ? 'error' : requirement.severity === 'warning' ? 'warning' : 'done'}
                          size={8}
                        />
                        <div>
                          <strong>{requirement.label}</strong>
                          <span>{requirement.description}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
            </DisclosureRow>
            <div className={css.panelActions}>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { void detachTemplate() }}>
                {state.action === 'detaching-template' ? t('template.detaching') : t('template.detach')}
              </Button>
            </div>
          </div>
        )}

      <div className={css.panelSection}>
        <h3>{t('template.apply')}</h3>
        {overview !== null && overview.template === null
          ? <p className={css.panelNote}>{t(overview.templatePackId === null ? 'template.projectNone' : 'start.templateMissing')}</p>
          : available.length === 0
            ? (
              <p className={css.panelNote}>
                {t('template.projectNoFormat', { type: t(DOCUMENT_TYPE_KEYS[document.documentType]) })}
              </p>
            )
            : (
              <>
                <span className={css.panelCaption}>{t('template.typeQuestion')}</span>
                <div className={css.applyRow}>
                  <Menu
                    compact
                    open={typeOpen}
                    selectedId={chosen}
                    items={available.map(type => ({ id: type, label: t(DOCUMENT_TYPE_KEYS[type]) }))}
                    anchor={(
                      <button
                        type="button"
                        className={css.select}
                        aria-label={t('template.typeQuestion')}
                        aria-haspopup="menu"
                        aria-expanded={typeOpen}
                        disabled={busy}
                        onClick={() => { setTypeOpen(open => !open) }}
                      >
                        <span>{chosen === undefined ? '' : t(DOCUMENT_TYPE_KEYS[chosen])}</span>
                        <IconChevronDownOutline14 />
                      </button>
                    )}
                    onSelect={(id) => {
                      setChosen(id as PaperAIDocumentType)
                      setTypeOpen(false)
                    }}
                    onClose={() => { setTypeOpen(false) }}
                  />
                  {guessedType !== undefined && (
                    <span className={css.panelCaption}>{t('template.typeGuess', { type: t(DOCUMENT_TYPE_KEYS[guessedType]) })}</span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !canApply}
                    onClick={() => { if (chosen !== undefined) void applyTemplate(chosen) }}
                  >
                    {state.action === 'applying-template'
                      ? t('template.applying')
                      : chosen === undefined ? t('template.apply') : t('template.applyAs', { type: t(DOCUMENT_TYPE_KEYS[chosen]) })}
                  </Button>
                </div>
              </>
            )}
        <button type="button" className={css.linkButton} disabled={busy} onClick={changeProject}>
          {t('template.changeProject')}
        </button>
      </div>
    </Panel>
  )
}

/** Gate panel: the latest check and the way to run or delegate the fixes. */
export function GatePanel({ document, state, validate, onSendFix, onClose, t }: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  validate: PaperAIDocumentWorkbenchProps['validate']
  onSendFix: () => void
  onClose: () => void
  t: Translate
}): ReactNode {
  const busy = state.action !== null
  const failing = document.gate.findings.filter(finding => !finding.passed).length
  const statusKey: PaperAIWorkbenchKey = document.gate.status === 'passed'
    ? 'gate.passed'
    : document.gate.status === 'failed' ? 'gate.failed' : 'gate.notRun'
  return (
    <Panel title={t('gate.title')} onClose={onClose} t={t}>
      <p className={css.panelNote}>{t(document.template === null ? 'gate.noTemplate' : 'gate.description')}</p>
      {document.template !== null && (
        <>
          <div className={css.gateStatus}>
            <StateDot
              state={document.gate.status === 'passed' ? 'done' : document.gate.status === 'failed' ? 'error' : 'warning'}
              size={8}
            />
            <span>{t(statusKey)}</span>
          </div>
          <div className={css.panelActions}>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void validate() }}>
              {state.action === 'validating' ? t('gate.validating') : t('gate.validate')}
            </Button>
            {failing > 0 && (
              <Button variant="toolbar" size="sm" onClick={onSendFix}>{t('gate.sendFix')}</Button>
            )}
          </div>
          {document.gate.findings.length > 0 && (
            <ul className={css.findingList}>
              {document.gate.findings.map(finding => <FindingRow key={finding.id} finding={finding} t={t} />)}
            </ul>
          )}
        </>
      )}
    </Panel>
  )
}

function ChangeRow({ change }: { change: PaperAIVersionChange }): ReactNode {
  return (
    <li className={css.change} data-kind={change.kind}>
      {change.before !== undefined && <del>{change.before === '' ? ' ' : change.before}</del>}
      {change.after !== undefined && <ins>{change.after === '' ? ' ' : change.after}</ins>}
    </li>
  )
}

/** Versions panel: the timeline, each version's changes on demand, and restore. */
export function VersionsPanel({ document, state, showDiff, restore, onClose, t }: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  showDiff: PaperAIDocumentWorkbenchProps['showDiff']
  restore: PaperAIDocumentWorkbenchProps['restore']
  onClose: () => void
  t: Translate
}): ReactNode {
  const busy = state.action !== null
  return (
    <Panel title={t('versions.title')} onClose={onClose} t={t}>
      {document.versions.length === 0
        ? <p className={css.panelNote}>{t('versions.empty')}</p>
        : (
          <ol className={css.versionList}>
            {document.versions.map((version) => {
              const current = version.commitId === document.headCommitId
              const open = state.diff?.commitId === version.commitId
              const diff = open ? state.diff : null
              return (
                <li key={version.commitId} className={clsx(css.version, current && css.versionCurrent)}>
                  <div className={css.versionMain}>
                    <strong>{version.summary}</strong>
                    <span>
                      <span className={css.actorBadge} data-client={actorClient(version)}>{actorBadge(version, t)}</span>
                      <time dateTime={version.createdAt}>{versionDate(version.createdAt)}</time>
                      {current && <em>{t('versions.current')}</em>}
                    </span>
                  </div>
                  <div className={css.versionActions}>
                    <Button
                      variant="toolbar"
                      size="sm"
                      aria-expanded={open}
                      disabled={busy && !open}
                      onClick={() => { void showDiff(version.commitId) }}
                    >
                      {open ? t('versions.diffHide') : t('versions.diff')}
                    </Button>
                    {version.restorable && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void restore(version.commitId) }}>
                        {state.action === 'restoring' ? t('versions.restoring') : t('versions.restore')}
                      </Button>
                    )}
                  </div>
                  {diff !== null && (
                    <div className={css.diff}>
                      {diff.result === null && diff.error === null && (
                        <p className={css.panelNote} aria-live="polite">{t('versions.diffLoading')}</p>
                      )}
                      {diff.error !== null && <p className={css.panelError} role="alert">{t('versions.diffError')}</p>}
                      {diff.result !== null && (
                        <>
                          {diff.result.parentCommitId === null && (
                            <span className={css.panelCaption}>{t('versions.root')}</span>
                          )}
                          {diff.result.changes.length === 0
                            ? <p className={css.panelNote}>{t('versions.diffEmpty')}</p>
                            : (
                              <ul className={css.changeList}>
                                {diff.result.changes.map((change, index) => (
                                  <ChangeRow key={`${change.kind}:${index}`} change={change} />
                                ))}
                              </ul>
                            )}
                          <span className={css.panelCaption}>
                            {t('versions.diffUnchanged', { count: diff.result.unchangedCount })}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
    </Panel>
  )
}
