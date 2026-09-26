/** The document view: facts and actions in the header, one row of commands, the document itself, and one open panel. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, DetailsViewShell, IconChevronDownOutline14, IconDownloadOutline16, IconFullscreenOutline16, IconRefreshOutline14, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIDocumentSnapshot, PaperAIExportMode, PaperAIWorkbenchPanel, PaperAIWorkbenchState } from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import { DocumentPreview } from './DocumentPreview.tsx'
import { fixPromptText, GatePanel, TemplatePanel, VersionsPanel } from './panels.tsx'
import { markDiffHtml } from './preview-html.ts'
import { TemplateDialog } from './TemplateLibrary.tsx'
import type { PaperAIWorkbenchKey } from './locales.ts'
import css from './DocumentWorkbench.module.css'

type Translate = PaperAIDocumentWorkbenchProps['t']

const EXPORT_MODES: readonly PaperAIExportMode[] = ['draft-export', 'delivery-export']

/** Actionable controller failures have specific guidance; other failures offer a retry. */
function actionErrorKey(error: string): PaperAIWorkbenchKey {
  if (error.includes('UNSUPPORTED_DOCUMENT_CONTENT:')) return 'workbench.unsupportedContent'
  if (error.includes('Working DOCX differs from head')) return 'workbench.workingChanged'
  if (error.startsWith('delivery blocked')) return 'export.blocked'
  if (error.startsWith('block changed externally')) return 'block.conflicted'
  // Both real conflict failures, which until now landed on the generic retry: one from the commit
  // service when a block's base text went stale, one from the workbench when the whole document did.
  // Pressing 保存 again cannot clear either; reloading is what produces the bands that can.
  if (error.includes('NODE_TEXT_CONFLICT') || error.includes('changed; reload before applying')) return 'workbench.reloadFirst'
  if (error === 'save or cancel the current block first') return 'block.busy'
  return 'workbench.actionError'
}

/** Facts under the title: the template, the gate, and the versions open their panels; the save state closes the line. */
function Facts({ document, state, panel, showPanel, t }: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  panel: PaperAIWorkbenchPanel | null
  showPanel: PaperAIDocumentWorkbenchProps['showPanel']
  t: Translate
}): ReactNode {
  const failing = document.gate.findings.filter(finding => !finding.passed).length
  const gateKey: PaperAIWorkbenchKey = document.gate.status === 'passed'
    ? 'toolbar.gatePassed'
    : document.gate.status === 'failed' ? 'toolbar.gateFailed' : 'toolbar.gateNotRun'
  const saveKey: PaperAIWorkbenchKey = state.action === 'committing'
    ? 'block.saving'
    : state.edits.length > 0 ? 'status.unsaved' : 'status.saved'
  const fact = (id: PaperAIWorkbenchPanel, label: ReactNode, extra: Record<string, string | undefined> = {}): ReactNode => (
    <button type="button" className={css.fact} data-kind={id} aria-pressed={panel === id} onClick={() => { showPanel(id) }} {...extra}>
      {label}
    </button>
  )
  const dot = <span className={css.dot} aria-hidden="true">·</span>
  return (
    <div className={css.facts} data-paperai-toolbar>
      {fact('template', document.template?.name ?? t('toolbar.template'), {
        'data-attached': document.template !== null ? 'true' : 'false',
        title: t('toolbar.template'),
      })}
      {document.template !== null && (
        <>
          {dot}
          {fact('gate', (
            <>
              <StateDot
                state={document.gate.status === 'passed' ? 'done' : document.gate.status === 'failed' ? 'error' : 'warning'}
                size={6}
              />
              <span>{t(gateKey, { count: failing })}</span>
            </>
          ), { 'data-status': document.gate.status, title: t('toolbar.gate') })}
        </>
      )}
      {dot}
      {fact('versions', t('toolbar.versions', { count: document.versions.length }))}
      {dot}
      <span
        role="status"
        aria-live="polite"
        className={css.saveStatus}
        data-state={saveKey === 'status.unsaved' ? 'unsaved' : undefined}
      >
        {t(saveKey, { count: state.edits.length })}
      </span>
    </div>
  )
}

/** Header actions: the focus toggle, then export, the one filled action in the column. */
function Actions({ state, exportDocument, focusActive, toggleFocus, t }: {
  state: PaperAIWorkbenchState
  exportDocument: PaperAIDocumentWorkbenchProps['exportDocument']
  focusActive: boolean
  toggleFocus: () => void
  t: Translate
}): ReactNode {
  const [exportOpen, setExportOpen] = useState(false)
  const busy = state.action !== null
  const dirty = state.edits.length > 0
  const exporting = state.action === 'exporting-draft' || state.action === 'exporting-delivery'
  return (
    <div className={css.actions} data-paperai-toolbar>
      <button
        type="button"
        className={css.chip}
        data-kind="focus"
        aria-pressed={focusActive}
        title={t(focusActive ? 'workbench.collaborate' : 'workbench.focus')}
        onClick={toggleFocus}
      >
        <IconFullscreenOutline16 size={14} />
        <span>{t(focusActive ? 'workbench.collaborate' : 'workbench.focus')}</span>
      </button>
      <Menu
        portal
        align="end"
        open={exportOpen}
        items={EXPORT_MODES.map(mode => ({
          id: mode,
          label: t(mode === 'draft-export' ? 'toolbar.exportDraft' : 'toolbar.exportDelivery'),
          icon: <IconDownloadOutline16 size={14} />,
        }))}
        anchor={(
          <button
            type="button"
            className={css.chip}
            data-kind="export"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            disabled={busy || dirty}
            title={t(dirty ? 'export.saveFirst' : 'export.description')}
            onClick={() => { setExportOpen(open => !open) }}
          >
            <IconDownloadOutline16 size={14} />
            <span>{exporting ? t('toolbar.exporting') : t('toolbar.export')}</span>
            <IconChevronDownOutline14 />
          </button>
        )}
        onSelect={(id) => {
          setExportOpen(false)
          void exportDocument(id as PaperAIExportMode)
        }}
        onClose={() => { setExportOpen(false) }}
      />
    </div>
  )
}

/** Render the PaperAI full-column details contribution. */
export function DocumentWorkbench({
  closeDetails, prepareAgentFix, useWorkbench, useProjects, useLibrary, quoteSelection, setScroll,
  retryOpen, showPanel, updateDraft, resolveConflict, cancelEdit, commitEdit, validate, suggestType,
  applyTemplate, detachTemplate, setProjectTemplate, showDiff, restore, exportDocument, reloadExternal, captureExternal,
  setDetailsFocus, showConversation, loadLibrary, createTemplateSet, deleteTemplateSet, addTemplateFormat, removeTemplateFormat, t,
  useStore, actions,
}: PaperAIDocumentWorkbenchProps): ReactNode {
  const state = useWorkbench(value => value)
  const document = state.document
  const overview = useProjects(directory => (
    document === null ? null : directory.workspaces[document.workspaceId]?.overview ?? null
  ))
  const library = useLibrary(value => value)
  const focusActive = useStore(value => value.writing)
  const zoom = useStore(value => value.zoom)
  const [dialogOpen, setDialogOpen] = useState(false)
  // The compared version's own page while the versions panel is open, its changes marked in place; a
  // root version measured from nothing shows its page unmarked.
  const result = state.panel === 'versions' ? state.diff?.result ?? null : null
  const compare = useMemo(
    () => (result === null ? null : markDiffHtml(result.previewHtml, result.baseCommitId === null ? [] : result.steps)),
    [result],
  )
  // The banner names the version on the page while it is not the current one.
  const viewing = result !== null && document !== null && result.commitId !== document.headCommitId
    ? document.versions.find(version => version.commitId === result.commitId)?.summary ?? ''
    : null
  const ready = state.phase === 'ready' && document !== null
  const panelOpen = ready && state.panel !== null
  useEffect(() => {
    setDetailsFocus(focusActive || panelOpen)
    return () => { setDetailsFocus(false) }
  }, [focusActive, panelOpen, setDetailsFocus])
  useEffect(() => {
    if (dialogOpen) void loadLibrary()
  }, [dialogOpen, loadLibrary])
  // The unload guard is the controller's: it owns the drafts of documents this view no longer shows.
  const toggleFocus = (): void => {
    if (focusActive || panelOpen) showConversation()
    else actions.setWriting(true)
  }
  const receiptKey: PaperAIWorkbenchKey | null = state.exportReceipt === null
    ? null
    : state.exportReceipt.mode === 'draft-export' ? 'export.draftDone' : 'export.deliveryDone'

  return (
    <DetailsViewShell
      className={css.root ?? ''}
      title={document?.title ?? t('workbench.title')}
      {...document === null ? {} : { titleHint: document.path }}
      subtitle={ready
        ? <Facts document={document} state={state} panel={state.panel} showPanel={showPanel} t={t} />
        : undefined}
      actions={ready ? (
        <Actions
          state={state}
          exportDocument={exportDocument}
          focusActive={focusActive || panelOpen}
          toggleFocus={toggleFocus}
          t={t}
        />
      ) : undefined}
      closeLabel={t('workbench.close')}
      onClose={closeDetails}
    >
      {state.externalUpdate !== null && (
        <div className={css.notice} role="status">
          <div>
            <strong>{t('external.title')}</strong>
            <span>{t('external.description')}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            icon={<IconRefreshOutline14 />}
            disabled={state.action !== null}
            onClick={() => { void reloadExternal() }}
          >
            {state.action === 'reloading-external' ? t('external.loading') : t('external.load')}
          </Button>
        </div>
      )}
      {state.exportReceipt !== null && receiptKey !== null && (
        <div className={clsx(css.notice, css.receipt)} role="status">
          <div>
            <strong>{t(receiptKey)}</strong>
            <span>{state.exportReceipt.outputPath}</span>
          </div>
        </div>
      )}
      {state.actionError !== null && actionErrorKey(state.actionError) === 'workbench.workingChanged' && (
        <div className={css.notice} role="alert">
          <div>
            <strong>{t('workbench.workingChanged')}</strong>
            <span>{t('workbench.workingChangedHint')}</span>
          </div>
          <Button variant="outline" size="sm" disabled={state.action !== null} onClick={() => { void captureExternal() }}>
            {state.action === 'capturing-external' ? t('workbench.capturing') : t('workbench.capture')}
          </Button>
        </div>
      )}
      {state.actionError !== null && actionErrorKey(state.actionError) !== 'workbench.workingChanged' && (
        <p className={css.actionError} role="alert">{t(actionErrorKey(state.actionError))}</p>
      )}
      {ready && compare !== null && viewing !== null && (
        <div className={css.notice} role="status">
          <div>
            <strong>{t('versions.viewing', { summary: viewing })}</strong>
            <span>{t('versions.viewingHint')}</span>
          </div>
        </div>
      )}
      <main className={css.body} data-panel={panelOpen || undefined}>
        {state.phase === 'idle' && <p className={css.centerMessage}>{t('workbench.idle')}</p>}
        {state.phase === 'loading' && <p className={css.centerMessage} aria-live="polite">{t('workbench.loading')}</p>}
        {state.phase === 'error' && (
          <div className={css.failure} role="alert">
            <span>{t('workbench.error')}</span>
            <Button variant="outline" size="sm" icon={<IconRefreshOutline14 />} onClick={() => { void retryOpen() }}>
              {t('workbench.retry')}
            </Button>
          </div>
        )}
        {[...state.retained, ...(ready ? [state] : [])].map(view => (
          view.document === null ? null : view.document.previewHtml === ''
            ? <p key={view.document.documentId} hidden={view !== state} className={css.centerMessage}>{t('preview.unavailable')}</p>
            : (
              <DocumentPreview
                key={view.document.documentId}
                html={view === state && compare !== null ? compare.html : view.document.previewHtml}
                revision={view.document.revision}
                nodes={view.document.nodes}
                paragraphStyles={view.document.paragraphStyles}
                active={view === state}
                scrollTop={view.scrollTop}
                reveal={view === state ? state.reveal : null}
                onScroll={setScroll}
                onQuote={(excerpt, request) => { if (view.document !== null) quoteSelection(view.document, excerpt, request) }}
                title={t('preview.title')}
                edits={view.edits}
                comparing={view === state && compare !== null}
                saving={state.action === 'committing'}
                busy={state.action !== null}
                zoom={zoom}
                onZoom={actions.setZoom}
                onDraft={updateDraft}
                onResolveConflict={resolveConflict}
                onSave={() => { void commitEdit() }}
                onCancel={cancelEdit}
                t={t}
              />
            )
        ))}
        {ready && state.panel === 'template' && (
          <TemplatePanel
            document={document}
            state={state}
            overview={overview}
            applyTemplate={applyTemplate}
            detachTemplate={detachTemplate}
            suggestType={suggestType}
            changeProject={() => { setDialogOpen(true) }}
            onClose={() => { showPanel(null) }}
            t={t}
          />
        )}
        {ready && state.panel === 'gate' && (
          <GatePanel
            document={document}
            state={state}
            validate={validate}
            onSendFix={() => { prepareAgentFix(fixPromptText(document, t)) }}
            onClose={() => { showPanel(null) }}
            t={t}
          />
        )}
        {ready && state.panel === 'versions' && (
          <VersionsPanel
            document={document}
            state={state}
            showDiff={showDiff}
            restore={restore}
            onClose={() => { showPanel(null) }}
            t={t}
          />
        )}
      </main>
      {document !== null && (
        <TemplateDialog
          open={dialogOpen}
          onClose={() => { setDialogOpen(false) }}
          state={library}
          project={{
            packId: overview?.templatePackId ?? null,
            decided: overview?.templateDecided ?? false,
            choosing: false,
            choose: async (packId) => {
              const result = await setProjectTemplate(document.workspaceId, packId)
              if (result.ok) setDialogOpen(false)
              return result
            },
          }}
          loadLibrary={loadLibrary}
          createTemplateSet={createTemplateSet}
          deleteTemplateSet={deleteTemplateSet}
          addTemplateFormat={addTemplateFormat}
          removeTemplateFormat={removeTemplateFormat}
          t={t}
        />
      )}
    </DetailsViewShell>
  )
}
