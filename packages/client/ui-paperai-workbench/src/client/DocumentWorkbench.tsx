/** PaperAI read-only preview, semantic-node edit, version, and template-gate details view. */

import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, DetailsViewShell, DisclosureRow, IconCheckOutline14, IconChecklistOutline14,
  IconChevronDownOutline14, IconDownloadOutline16, IconPlusOutline16, IconRefreshOutline14,
  IconWarningOutline16, Menu, Pill, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PaperAIDocumentNodeKind, PaperAIDocumentRole, PaperAIDocumentSnapshot,
  PaperAIDocumentVersion, PaperAIGateFinding, PaperAITemplateContractChoice,
  PaperAITemplateUsage, PaperAIWorkbenchState, PaperAIWorkbenchTab,
} from './types.ts'
import { readWordFileBase64, wordStem } from './browser-file.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import type { PaperAIWorkbenchKey } from './locales.ts'
import css from './DocumentWorkbench.module.css'

const TABS: readonly PaperAIWorkbenchTab[] = ['preview', 'edit', 'versions', 'gate']

const TAB_KEYS = {
  preview: 'tab.preview',
  edit: 'tab.edit',
  versions: 'tab.versions',
  gate: 'tab.gate',
} satisfies Record<PaperAIWorkbenchTab, PaperAIWorkbenchKey>

const NODE_KIND_KEYS = {
  paragraph: 'edit.kind.paragraph',
  heading: 'edit.kind.heading',
  table: 'edit.kind.table',
  'table-cell': 'edit.kind.tableCell',
  field: 'edit.kind.field',
  unknown: 'edit.kind.unknown',
} satisfies Record<PaperAIDocumentNodeKind, PaperAIWorkbenchKey>

const ROLE_KEYS = {
  manuscript: 'role.manuscript',
  proposal: 'role.proposal',
  midterm: 'role.midterm',
  final: 'role.final',
  other: 'role.other',
} satisfies Record<PaperAIDocumentRole, PaperAIWorkbenchKey>

const USAGE_KEYS = {
  'form-template': 'template.usage.form',
  'format-reference': 'template.usage.reference',
} satisfies Record<PaperAITemplateUsage, PaperAIWorkbenchKey>

/** Browser-local date formatting; the Host retains the exact ISO timestamp. */
function versionDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date)
}

/** Visible actor line preserving Agent client and exact model provenance. */
function actorLabel(version: PaperAIDocumentVersion): string {
  if (version.actor.kind !== 'agent') return version.actor.name
  const agent = [version.actor.client, version.actor.model].filter(value => value !== undefined && value !== '')
  return agent.length === 0 ? version.actor.name : agent.join(' / ')
}

/** Sandboxed OfficeCLI-derived document preview. */
function PreviewView({ document, t }: {
  document: PaperAIDocumentSnapshot
  t: PaperAIDocumentWorkbenchProps['t']
}): ReactNode {
  return (
    <section className={css.view} aria-labelledby="paperai-preview-heading">
      <h2 className={css.visuallyHidden} id="paperai-preview-heading">{t('preview.title')}</h2>
      {document.previewHtml === ''
        ? <p className={css.empty}>{t('preview.unavailable')}</p>
        : (
          <iframe
            className={css.documentFrame}
            title={t('preview.title')}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={document.previewHtml}
          />
        )}
    </section>
  )
}

/** Temporary editor for the selected semantic node. */
function SelectedNodeEditor({ state, updateDraft, discardDraft, commitSelected, t }: {
  state: PaperAIWorkbenchState
  updateDraft: PaperAIDocumentWorkbenchProps['updateDraft']
  discardDraft: PaperAIDocumentWorkbenchProps['discardDraft']
  commitSelected: PaperAIDocumentWorkbenchProps['commitSelected']
  t: PaperAIDocumentWorkbenchProps['t']
}): ReactNode {
  if (state.nodePhase === 'loading') {
    return <p className={css.nodeMessage} aria-live="polite">{t('edit.loading')}</p>
  }
  if (state.nodePhase === 'error') {
    return <p className={css.nodeError} role="alert">{t('edit.nodeError', { message: state.nodeError ?? '' })}</p>
  }
  const buffer = state.selectedNode
  if (buffer === null) return <p className={css.nodeMessage}>{t('edit.select')}</p>
  const disabled = state.action !== null
  const base = buffer.baseCommitId ?? buffer.baseRevision
  return (
    <div className={css.nodeEditor}>
      <div className={css.nodeEditorHeader}>
        <div>
          <h2>{buffer.label}</h2>
          <span title={base}>{t('edit.base', { value: base })}</span>
        </div>
        <div className={css.nodeActions}>
          <Button
            variant="toolbar"
            size="sm"
            disabled={!state.dirty || disabled}
            onClick={() => { discardDraft() }}
          >
            {t('edit.discard')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!state.dirty || disabled}
            onClick={() => { void commitSelected() }}
          >
            {state.action === 'committing' ? t('edit.committing') : t('edit.commit')}
          </Button>
        </div>
      </div>
      <textarea
        className={css.textEditor}
        aria-label={t('edit.textLabel', { name: buffer.label })}
        value={state.draft}
        disabled={disabled}
        spellCheck
        onChange={(event) => { updateDraft(event.currentTarget.value) }}
      />
    </div>
  )
}

/** Selected semantic-node buffer editor; the complete document remains preview-only. */
function EditView({ document, state, selectNode, updateDraft, discardDraft, commitSelected, t }: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  selectNode: PaperAIDocumentWorkbenchProps['selectNode']
  updateDraft: PaperAIDocumentWorkbenchProps['updateDraft']
  discardDraft: PaperAIDocumentWorkbenchProps['discardDraft']
  commitSelected: PaperAIDocumentWorkbenchProps['commitSelected']
  t: PaperAIDocumentWorkbenchProps['t']
}): ReactNode {
  const editableCount = document.nodes.filter(node => node.editable).length
  return (
    <section className={css.editView} aria-labelledby="paperai-edit-heading">
      <aside className={css.nodeOutline} aria-label={t('edit.nodes')}>
        <div className={css.outlineHeading}>
          <h2 id="paperai-edit-heading">{t('edit.nodes')}</h2>
          <span>{editableCount}</span>
        </div>
        {document.nodes.length === 0 ? <p className={css.outlineEmpty}>{t('edit.noNodes')}</p> : (
          <div className={css.nodeList}>
            {document.nodes.map((node) => {
              const selected = state.selectedNode?.nodeId === node.nodeId
              const locked = state.dirty && !selected
              const style = {
                '--paperai-node-indent': `${10 + Math.max(0, Math.min(8, node.depth)) * 14}px`,
              } as CSSProperties
              const contents = (
                <>
                  <span className={css.nodeLabel}>{node.label}</span>
                  <span className={css.nodeKind}>{t(NODE_KIND_KEYS[node.kind])}</span>
                </>
              )
              return node.editable ? (
                <button
                  type="button"
                  key={node.nodeId}
                  className={clsx(css.nodeRow, css.nodeButton)}
                  style={style}
                  aria-current={selected ? 'true' : undefined}
                  disabled={state.action !== null || locked}
                  title={locked ? t('edit.unsavedLock') : node.label}
                  onClick={() => { void selectNode(node.nodeId) }}
                >
                  {contents}
                </button>
              ) : (
                <div
                  key={node.nodeId}
                  className={clsx(css.nodeRow, css.nodeStatic)}
                  style={style}
                  aria-disabled="true"
                >
                  {contents}
                </div>
              )
            })}
          </div>
        )}
        {state.dirty && <p className={css.unsavedHint}>{t('edit.unsavedLock')}</p>}
      </aside>
      <SelectedNodeEditor
        state={state}
        updateDraft={updateDraft}
        discardDraft={discardDraft}
        commitSelected={commitSelected}
        t={t}
      />
    </section>
  )
}

/** Flat durable history with row-level restore actions. */
function VersionsView({ document, state, restore, t }: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  restore: PaperAIDocumentWorkbenchProps['restore']
  t: PaperAIDocumentWorkbenchProps['t']
}): ReactNode {
  return (
    <section className={css.scrollView} aria-labelledby="paperai-versions-heading">
      <div className={css.sectionHeading}>
        <h2 id="paperai-versions-heading">{t('versions.title')}</h2>
        <span>{document.versions.length}</span>
      </div>
      {state.dirty && <p className={css.inlineNotice}>{t('versions.dirtyLock')}</p>}
      {document.versions.length === 0 ? <p className={css.empty}>{t('versions.empty')}</p> : (
        <ol className={css.versionList}>
          {document.versions.map(version => (
            <li className={css.versionRow} key={version.commitId}>
              <div className={css.versionMain}>
                <strong>{version.summary}</strong>
                <span>{actorLabel(version)}</span>
              </div>
              <div className={css.versionMeta}>
                <time dateTime={version.createdAt}>{versionDate(version.createdAt)}</time>
                {version.restorable && (
                  <Button
                    variant="toolbar"
                    size="sm"
                    disabled={state.action !== null || state.nodePhase === 'loading' || state.dirty}
                    onClick={() => { void restore(version.commitId) }}
                  >
                    {state.action === 'restoring' ? t('versions.restoring') : t('versions.restore')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** One template requirement row. */
function FindingRow({ finding, t }: {
  finding: PaperAIGateFinding
  t: PaperAIDocumentWorkbenchProps['t']
}): ReactNode {
  return (
    <li className={css.finding} data-severity={finding.severity} data-passed={finding.passed ? 'true' : 'false'}>
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

/** Whether one installed contract is the template currently projected by the document. */
function isCurrentTemplate(
  document: PaperAIDocumentSnapshot,
  contract: PaperAITemplateContractChoice,
): boolean {
  return document.template?.templateId === contract.templateId
}

/** Invalidate a browser-local review acknowledgement when parsed requirements change. */
function contractReviewKey(contract: PaperAITemplateContractChoice): string {
  const requirements = contract.requirements
    .map(requirement => [
      requirement.ruleId, requirement.kind, requirement.enabled,
      requirement.severity, requirement.confidence,
    ].join(':'))
    .join('|')
  return `${contract.templateId}:${requirements}`
}

/** Parsed, reviewable template packs and contracts. */
function TemplateCatalogView({
  document, state, loadTemplates, installTemplate, uploadTemplate, confirmTemplate, associateTemplate, t,
}: Pick<PaperAIDocumentWorkbenchProps,
  'loadTemplates' | 'installTemplate' | 'uploadTemplate' | 'confirmTemplate' | 'associateTemplate' | 't'
> & { document: PaperAIDocumentSnapshot; state: PaperAIWorkbenchState }): ReactNode {
  const uploadInput = useRef<HTMLInputElement>(null)
  const [usage, setUsage] = useState<PaperAITemplateUsage>('form-template')
  const [usageMenuOpen, setUsageMenuOpen] = useState(false)
  const [readingUpload, setReadingUpload] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const catalog = state.templates
  const busy = state.action !== null || readingUpload || state.nodePhase === 'loading' || state.dirty

  const uploadWord = async (file: File): Promise<void> => {
    setReadingUpload(true)
    setUploadError(null)
    try {
      const result = await uploadTemplate({
        fileName: file.name,
        contentBase64: await readWordFileBase64(file),
        name: wordStem(file.name),
        usage,
      })
      if (!result.ok) setUploadError(result.error)
    } catch {
      setUploadError(t('import.invalid'))
    } finally {
      setReadingUpload(false)
    }
  }

  return (
    <section className={css.gateSection} aria-labelledby="paperai-template-heading">
      <div className={css.sectionHeading}>
        <div>
          <h2 id="paperai-template-heading">{t('template.title')}</h2>
          <p>{t('template.description', { role: t(ROLE_KEYS[document.role]) })}</p>
        </div>
        <Button
          variant="toolbar"
          size="sm"
          icon={<IconRefreshOutline14 />}
          disabled={state.action !== null}
          onClick={() => { void loadTemplates() }}
        >
          {state.action === 'loading-templates' ? t('template.loading') : t('template.refresh')}
        </Button>
      </div>

      {catalog === null ? (
        <p className={css.empty}>{state.action === 'loading-templates' ? t('template.loading') : t('template.empty')}</p>
      ) : (
        <>
          {catalog.packs.map(pack => (
            <div className={css.templateGroup} key={pack.packId}>
              <div className={css.templateGroupHeading}>
                <div>
                  <strong>{pack.name}</strong>
                  <span>{pack.description}</span>
                </div>
                <Pill>{pack.version}</Pill>
              </div>
              <div className={css.templateRows}>
                {pack.members.map((member) => {
                  const compatible = member.appliesToRoles.includes(document.role)
                  const installed = catalog.contracts.some(contract => (
                    contract.originPackId === pack.packId && contract.originMemberId === member.memberId
                  ))
                  return (
                    <div className={css.templateRow} key={member.memberId}>
                      <div className={css.templateMain}>
                        <strong>{member.name}</strong>
                        <span>{member.description}</span>
                        <small>{t(USAGE_KEYS[member.usage])} · {member.originalFileName}</small>
                      </div>
                      <Button
                        variant="toolbar"
                        size="sm"
                        disabled={busy || installed || !compatible}
                        onClick={() => { void installTemplate(pack.packId, member.memberId) }}
                      >
                        {installed
                          ? t('template.installed')
                          : compatible ? t('template.install') : t('template.incompatible')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          <div className={css.templateGroup}>
            <div className={css.templateGroupHeading}>
              <div>
                <strong>{t('template.contracts')}</strong>
                <span>{t('template.contractsDescription')}</span>
              </div>
              <Pill>{catalog.contracts.length}</Pill>
            </div>
            {catalog.contracts.length === 0 ? <p className={css.empty}>{t('template.noContracts')}</p> : (
              <div className={css.templateRows}>
                {catalog.contracts.map((contract) => {
                  const compatible = contract.appliesToRoles.includes(document.role)
                  const current = isCurrentTemplate(document, contract)
                  const reviewKey = contractReviewKey(contract)
                  const accepted = reviewed.has(reviewKey)
                  const requirementsOpen = expanded.has(reviewKey)
                  return (
                    <div className={css.contractRow} key={contract.templateId}>
                      <div className={css.templateMain}>
                        <div className={css.contractTitle}>
                          <strong>{contract.name}</strong>
                          <Pill>{contract.status === 'confirmed' ? t('template.confirmed') : t('template.draft')}</Pill>
                        </div>
                        <span>
                          {t(`gate.source.${contract.source}`)} · {t(USAGE_KEYS[contract.usage])}
                          {' · '}{t('template.ruleCount', { rules: contract.ruleCount, slots: contract.slotCount })}
                        </span>
                        <DisclosureRow
                          className={css.contractDisclosure}
                          icon={<IconChecklistOutline14 />}
                          title={t('template.reviewRequirements', { count: contract.requirements.length })}
                          open={requirementsOpen}
                          expandable
                          expandOnRowClick
                          onToggle={() => {
                            setExpanded((currentSet) => {
                              const next = new Set(currentSet)
                              if (requirementsOpen) next.delete(reviewKey)
                              else next.add(reviewKey)
                              return next
                            })
                          }}
                        >
                          <div className={css.contractReview}>
                            {contract.requirements.length === 0 ? <p>{t('template.noRequirements')}</p> : (
                              <ul className={css.requirementList}>
                                {contract.requirements.map(requirement => (
                                  <li key={requirement.ruleId} data-enabled={requirement.enabled ? 'true' : 'false'}>
                                    <StateDot state={requirement.severity === 'error' ? 'error' : requirement.severity === 'warning' ? 'warning' : 'done'} size={8} />
                                    <div>
                                      <strong>{requirement.label}</strong>
                                      <span>{requirement.description}</span>
                                      <small>{requirement.kind} · {t('template.confidence', {
                                        value: Math.round(requirement.confidence <= 1
                                          ? requirement.confidence * 100
                                          : requirement.confidence),
                                      })}</small>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {contract.status === 'draft' && (
                              <div className={css.contractReviewActions}>
                                <label className={css.reviewCheck}>
                                  <input
                                    type="checkbox"
                                    checked={accepted}
                                    onChange={(event) => {
                                      const checked = event.currentTarget.checked
                                      setReviewed((currentSet) => {
                                        const next = new Set(currentSet)
                                        if (checked) next.add(reviewKey)
                                        else next.delete(reviewKey)
                                        return next
                                      })
                                    }}
                                  />
                                  <span>{t('template.reviewed')}</span>
                                </label>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy || !accepted}
                                  onClick={() => { void confirmTemplate(contract.templateId) }}
                                >
                                  {state.action === 'confirming-template' ? t('template.confirming') : t('template.confirm')}
                                </Button>
                              </div>
                            )}
                          </div>
                        </DisclosureRow>
                      </div>
                      {contract.status === 'confirmed' && (
                        <div className={css.contractActions}>
                          <Button
                            variant={current ? 'toolbar' : 'outline'}
                            size="sm"
                            disabled={busy || current || !compatible}
                            onClick={() => { void associateTemplate(contract.templateId) }}
                          >
                            {current
                              ? t('template.linked')
                              : compatible ? t('template.link') : t('template.incompatible')}
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      <div className={css.customUpload}>
        <div className={css.templateMain}>
          <strong>{t('template.custom')}</strong>
          <span>{t('template.customDescription', { role: t(ROLE_KEYS[document.role]) })}</span>
        </div>
        <Menu
          compact
          open={usageMenuOpen}
          selectedId={usage}
          items={(['form-template', 'format-reference'] as const).map(value => ({
            id: value,
            label: t(USAGE_KEYS[value]),
          }))}
          anchor={(
            <button
              type="button"
              className={css.nativeSelect}
              aria-label={t('template.usage')}
              aria-expanded={usageMenuOpen}
              disabled={busy}
              onClick={() => { setUsageMenuOpen(open => !open) }}
            >
              <span>{t(USAGE_KEYS[usage])}</span>
              <IconChevronDownOutline14 />
            </button>
          )}
          onSelect={(value) => {
            setUsage(value as PaperAITemplateUsage)
            setUsageMenuOpen(false)
          }}
          onClose={() => { setUsageMenuOpen(false) }}
        />
        <input
          ref={uploadInput}
          className={css.visuallyHidden}
          type="file"
          accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          tabIndex={-1}
          onChange={(event) => {
            const input = event.currentTarget
            const file = input.files?.[0]
            if (file !== undefined) void uploadWord(file).finally(() => { input.value = '' })
          }}
        />
        <Button
          variant="toolbar"
          size="sm"
          icon={<IconPlusOutline16 />}
          disabled={busy}
          onClick={() => { uploadInput.current?.click() }}
        >
          {state.action === 'uploading-template' || readingUpload
            ? t('template.uploading')
            : t('template.upload')}
        </Button>
      </div>
      {uploadError !== null && <p className={css.uploadError} role="alert">{uploadError}</p>}
    </section>
  )
}

/** Immutable draft and formal delivery export controls. */
function ExportView({ document, state, exportDocument, t }: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  exportDocument: PaperAIDocumentWorkbenchProps['exportDocument']
  t: PaperAIDocumentWorkbenchProps['t']
}): ReactNode {
  const busy = state.action !== null || state.nodePhase === 'loading' || state.dirty
  const deliveryUnavailable = document.template === null
  const deliveryBlocked = document.gate.status === 'failed'
  return (
    <section className={css.gateSection} aria-labelledby="paperai-export-heading">
      <div className={css.sectionHeading}>
        <div>
          <h2 id="paperai-export-heading">{t('export.title')}</h2>
          <p>{t('export.description')}</p>
        </div>
        <div className={css.exportActions}>
          <Button
            variant="toolbar"
            size="sm"
            icon={<IconDownloadOutline16 />}
            disabled={busy}
            onClick={() => { void exportDocument('draft-export') }}
          >
            {state.action === 'exporting-draft' ? t('export.exporting') : t('export.draft')}
          </Button>
          <Tooltip label={t('export.noTemplate')} side="bottom" disabled={!deliveryUnavailable}>
            <span className={css.exportActionAnchor} tabIndex={deliveryUnavailable ? 0 : -1}>
              <Button
                variant="outline"
                size="sm"
                icon={<IconCheckOutline14 />}
                disabled={busy || deliveryUnavailable}
                onClick={() => { void exportDocument('delivery-export') }}
              >
                {state.action === 'exporting-delivery' ? t('export.checking') : t('export.delivery')}
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>
      {state.dirty && <p className={css.inlineNotice}>{t('export.dirtyLock')}</p>}
      {!state.dirty && deliveryUnavailable && <p className={css.inlineNotice}>{t('export.noTemplate')}</p>}
      {!state.dirty && !deliveryUnavailable && deliveryBlocked && (
        <p className={css.inlineNotice} role="alert">{t('export.gateBlocked')}</p>
      )}
      {state.exportReceipt !== null && (
        <div className={css.exportReceipt} role="status">
          <IconCheckOutline14 />
          <div>
            <strong>{t(state.exportReceipt.mode === 'delivery-export' ? 'export.deliveryDone' : 'export.draftDone')}</strong>
            <span>{state.exportReceipt.fileName}</span>
            <code title={state.exportReceipt.outputPath}>{state.exportReceipt.outputPath}</code>
          </div>
        </div>
      )}
    </section>
  )
}

/** Template relationship, backed gate, template contracts, and delivery export. */
function GateView({
  document, state, validate, loadTemplates, installTemplate, uploadTemplate,
  confirmTemplate, associateTemplate, exportDocument, t,
}: Pick<PaperAIDocumentWorkbenchProps,
  | 'validate' | 'loadTemplates' | 'installTemplate' | 'uploadTemplate'
  | 'confirmTemplate' | 'associateTemplate' | 'exportDocument' | 't'
> & { document: PaperAIDocumentSnapshot; state: PaperAIWorkbenchState }): ReactNode {
  const report = document.gate
  return (
    <div className={css.scrollView}>
      <section className={css.gateOverview} aria-labelledby="paperai-gate-heading">
        <div className={css.sectionHeading}>
          <div>
            <h2 id="paperai-gate-heading">{t('gate.title')}</h2>
            <p>{t('gate.description')}</p>
          </div>
          {document.template !== null && (
            <Button
              variant="outline"
              size="sm"
              disabled={state.action !== null || state.nodePhase === 'loading' || state.dirty}
              onClick={() => { void validate() }}
            >
              {state.action === 'validating' ? t('gate.validating') : t('gate.validate')}
            </Button>
          )}
        </div>
        {document.template === null ? <p className={css.empty}>{t('gate.noTemplate')}</p> : (
          <>
            <div className={css.templateLine}>
              <div>
                <strong>{document.template.name}</strong>
                <span>
                  {t(`gate.source.${document.template.source}`)}
                  {document.template.version === undefined ? '' : ` · ${document.template.version}`}
                </span>
              </div>
              <Pill>{t('gate.findings', { count: report.findings.length })}</Pill>
            </div>
            <div className={css.gateStatus} data-status={report.status}>
              {report.status === 'passed' && <StateDot state="done" />}
              {report.status === 'failed' && <StateDot state="error" />}
              <span>{t(report.status === 'passed'
                ? 'gate.passed'
                : report.status === 'failed' ? 'gate.failed' : 'gate.notRun')}</span>
            </div>
            {report.findings.length > 0 && (
              <ul className={css.findingList}>
                {report.findings.map(finding => <FindingRow key={finding.id} finding={finding} t={t} />)}
              </ul>
            )}
          </>
        )}
      </section>
      <TemplateCatalogView
        document={document}
        state={state}
        loadTemplates={loadTemplates}
        installTemplate={installTemplate}
        uploadTemplate={uploadTemplate}
        confirmTemplate={confirmTemplate}
        associateTemplate={associateTemplate}
        t={t}
      />
      <ExportView document={document} state={state} exportDocument={exportDocument} t={t} />
    </div>
  )
}

/** Render the selected workbench tab. */
function ReadyView(props: Pick<
  PaperAIDocumentWorkbenchProps,
  | 'selectNode' | 'updateDraft' | 'discardDraft' | 'commitSelected' | 'validate' | 'restore'
  | 'loadTemplates' | 'installTemplate' | 'uploadTemplate' | 'confirmTemplate'
  | 'associateTemplate' | 'exportDocument' | 't'
> & { state: PaperAIWorkbenchState }): ReactNode {
  const document = props.state.document
  if (document === null) return null
  switch (props.state.tab) {
    case 'preview': return <PreviewView document={document} t={props.t} />
    case 'edit': return (
      <EditView
        document={document}
        state={props.state}
        selectNode={props.selectNode}
        updateDraft={props.updateDraft}
        discardDraft={props.discardDraft}
        commitSelected={props.commitSelected}
        t={props.t}
      />
    )
    case 'versions': return <VersionsView document={document} state={props.state} restore={props.restore} t={props.t} />
    case 'gate': return (
      <GateView
        document={document}
        state={props.state}
        validate={props.validate}
        loadTemplates={props.loadTemplates}
        installTemplate={props.installTemplate}
        uploadTemplate={props.uploadTemplate}
        confirmTemplate={props.confirmTemplate}
        associateTemplate={props.associateTemplate}
        exportDocument={props.exportDocument}
        t={props.t}
      />
    )
  }
}

/** Render the PaperAI full-column details contribution. */
export function DocumentWorkbench({
  closeDetails, useWorkbench, selectTab, retryOpen, selectNode, updateDraft,
  discardDraft, commitSelected, validate, loadTemplates, installTemplate,
  uploadTemplate, confirmTemplate, associateTemplate, exportDocument,
  reloadExternal, dismissExternal, restore, t,
}: PaperAIDocumentWorkbenchProps): ReactNode {
  const state = useWorkbench(value => value)
  const document = state.document
  const tabs = document === null ? [] : TABS.map(tab => ({ id: tab, label: t(TAB_KEYS[tab]) }))
  return (
    <DetailsViewShell
      className={css.root ?? ''}
      title={document?.title ?? t('workbench.title')}
      {...document === null ? {} : { subtitle: document.path }}
      closeLabel={t('workbench.close')}
      onClose={closeDetails}
      tabs={tabs}
      activeTab={state.tab}
      onSelectTab={(tab) => { selectTab(tab as PaperAIWorkbenchTab) }}
    >
      {state.externalUpdate !== null && (
        <div className={css.externalUpdate} role="status">
          <div>
            <strong>{t('external.title')}</strong>
            <span>{t(state.dirty ? 'external.dirtyDescription' : 'external.description')}</span>
          </div>
          <div className={css.externalActions}>
            <Button
              variant="toolbar"
              size="sm"
              disabled={state.action !== null}
              onClick={() => { dismissExternal() }}
            >
              {t('external.keep')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={state.action !== null}
              onClick={() => { void reloadExternal() }}
            >
              {state.action === 'reloading-external' ? t('external.loading') : t('external.load')}
            </Button>
          </div>
        </div>
      )}
      {state.actionError !== null && (
        <p className={css.actionError} role="alert">{t('workbench.actionError', { message: state.actionError })}</p>
      )}
      <main className={css.body}>
        {state.phase === 'idle' && <p className={css.centerMessage}>{t('workbench.idle')}</p>}
        {state.phase === 'loading' && <p className={css.centerMessage} aria-live="polite">{t('workbench.loading')}</p>}
        {state.phase === 'error' && (
          <div className={css.failure} role="alert">
            <span>{state.error ?? t('workbench.error')}</span>
            <Button
              variant="outline"
              size="sm"
              icon={<IconRefreshOutline14 />}
              onClick={() => { void retryOpen() }}
            >
              {t('workbench.retry')}
            </Button>
          </div>
        )}
        {state.phase === 'ready' && (
          <ReadyView
            state={state}
            selectNode={selectNode}
            updateDraft={updateDraft}
            discardDraft={discardDraft}
            commitSelected={commitSelected}
            validate={validate}
            loadTemplates={loadTemplates}
            installTemplate={installTemplate}
            uploadTemplate={uploadTemplate}
            confirmTemplate={confirmTemplate}
            associateTemplate={associateTemplate}
            exportDocument={exportDocument}
            restore={restore}
            t={t}
          />
        )}
      </main>
    </DetailsViewShell>
  )
}
