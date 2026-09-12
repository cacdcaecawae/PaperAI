/** The document view: the document itself, a toolbar of secondary entries, and one open panel. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, DetailsViewShell, IconBranchOutline16, IconChevronDownOutline14, IconDownloadOutline16,
  IconFullscreenOutline16, IconListPenOutline16, IconRefreshOutline14, Menu, StateDot,
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
  if (error === 'save or cancel the current block first') return 'block.busy'
  return 'workbench.actionError'
}

/** The row of entries above the document: template, gate, versions, export, focus. */
function Toolbar({ document, state, panel, showPanel, exportDocument, focusActive, toggleFocus, t }: {
  document: PaperAIDocumentSnapshot
  state: PaperAIWorkbenchState
  panel: PaperAIWorkbenchPanel | null
  showPanel: PaperAIDocumentWorkbenchProps['showPanel']
  exportDocument: PaperAIDocumentWorkbenchProps['exportDocument']
  focusActive: boolean
  toggleFocus: () => void
  t: Translate
}): ReactNode {
  const [exportOpen, setExportOpen] = useState(false)
  const busy = state.action !== null
  const dirty = state.edits.length > 0
  const exporting = state.action === 'exporting-draft' || state.action === 'exporting-delivery'
  const failing = document.gate.findings.filter(finding => !finding.passed).length
  const gateKey: PaperAIWorkbenchKey = document.gate.status === 'passed'
    ? 'toolbar.gatePassed'
    : document.gate.status === 'failed' ? 'toolbar.gateFailed' : 'toolbar.gateNotRun'
  const chip = (id: PaperAIWorkbenchPanel, label: ReactNode, extra: Record<string, string | undefined> = {}): ReactNode => (
    <button
      type="button"
      className={css.chip}
      data-kind={id}
      aria-pressed={panel === id}
      onClick={() => { showPanel(id) }}
      {...extra}
    >
      {label}
    </button>
  )
  return (
    <div className={css.toolbar} data-paperai-toolbar>
      <span className={css.facts}>
        {chip('template', (
          <>
            <IconListPenOutline16 size={14} />
            <span>{t('toolbar.template')}</span>
          </>
        ), {
          'data-attached': document.template !== null ? 'true' : 'false',
          title: document.template?.name ?? t('toolbar.templateNone'),
        })}
        {document.template !== null && chip('gate', (
          <>
            <StateDot
              state={document.gate.status === 'passed' ? 'done' : document.gate.status === 'failed' ? 'error' : 'warning'}
              size={8}
            />
            <span>{t(gateKey, { count: failing })}</span>
          </>
        ), { 'data-status': document.gate.status, title: t('toolbar.gate') })}
        {chip('versions', (
          <>
            <IconBranchOutline16 size={14} />
            <span>{t('toolbar.versions', { count: document.versions.length })}</span>
          </>
        ))}
      </span>
      <span className={css.tools}>
        <Menu
          portal
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
        <button
          type="button"
          className={clsx(css.chip, css.focusChip)}
          data-kind="focus"
          aria-pressed={focusActive}
          title={t(focusActive ? 'workbench.collaborate' : 'workbench.focus')}
          onClick={toggleFocus}
        >
          <IconFullscreenOutline16 size={14} />
          <span>{t(focusActive ? 'workbench.collaborate' : 'workbench.focus')}</span>
        </button>
      </span>
    </div>
  )
}

/** Render the PaperAI full-column details contribution. */
export function DocumentWorkbench({
  closeDetails, prepareAgentFix, useWorkbench, useProjects, useLibrary, quoteSelection, setScroll,
  retryOpen, showPanel, updateDraft, cancelEdit, commitEdit, validate, suggestType,
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
  // The picked version's changes marked on the current preview while the versions panel is open.
  const changes = state.panel === 'versions' ? state.diff?.result?.changes ?? null : null
  const compare = useMemo(
    () => (document === null || changes === null ? null : markDiffHtml(document.previewHtml, changes)),
    [document, changes],
  )
  const panelOpen = state.phase === 'ready' && document !== null && state.panel !== null
  useEffect(() => {
    setDetailsFocus(focusActive || panelOpen)
    return () => { setDetailsFocus(false) }
  }, [focusActive, panelOpen, setDetailsFocus])
  useEffect(() => {
    if (dialogOpen) void loadLibrary()
  }, [dialogOpen, loadLibrary])
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
      closeLabel={t('workbench.close')}
      onClose={closeDetails}
    >
      {state.phase === 'ready' && document !== null && (
        <Toolbar
          document={document}
          state={state}
          panel={state.panel}
          showPanel={showPanel}
          exportDocument={exportDocument}
          focusActive={focusActive || panelOpen}
          toggleFocus={toggleFocus}
          t={t}
        />
      )}
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
        {[...state.retained, ...(state.phase === 'ready' && document !== null ? [state] : [])].map(view => (
          view.document === null ? null : view.document.previewHtml === ''
            ? <p key={view.document.documentId} hidden={view !== state} className={css.centerMessage}>{t('preview.unavailable')}</p>
            : (
              <DocumentPreview
                key={view.document.documentId}
                html={view === state && compare !== null ? compare.html : view.document.previewHtml}
                revision={view.document.revision}
                nodes={view.document.nodes}
                active={view === state}
                scrollTop={view.scrollTop}
                onScroll={setScroll}
                onQuote={(excerpt) => { if (view.document !== null) quoteSelection(view.document, excerpt) }}
                title={t('preview.title')}
                edits={view.edits}
                comparing={view === state && compare !== null}
                saving={state.action === 'committing'}
                busy={state.action !== null}
                zoom={zoom}
                onDraft={updateDraft}
                onSave={() => { void commitEdit() }}
                onCancel={cancelEdit}
                t={t}
              />
            )
        ))}
        {state.phase === 'ready' && document !== null && state.panel === 'template' && (
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
        {state.phase === 'ready' && document !== null && state.panel === 'gate' && (
          <GatePanel
            document={document}
            state={state}
            validate={validate}
            onSendFix={() => { prepareAgentFix(fixPromptText(document, t)) }}
            onClose={() => { showPanel(null) }}
            t={t}
          />
        )}
        {state.phase === 'ready' && document !== null && state.panel === 'versions' && (
          <VersionsPanel
            document={document}
            state={state}
            unplaced={compare?.unplaced ?? []}
            showDiff={showDiff}
            restore={restore}
            onClose={() => { showPanel(null) }}
            t={t}
          />
        )}
      </main>
      {state.phase === 'ready' && document !== null && (
        <footer className={css.statusBar} aria-label={t('status.title')}>
          <span role="status" aria-live="polite" className={css.saveStatus}>
            {t(state.action === 'committing' ? 'block.saving'
              : state.actionError !== null ? 'status.failed'
                : state.edits.length > 0 ? 'status.unsaved' : 'status.saved', { count: state.edits.length })}
          </span>
          <span className={css.statusHint}>{t(state.edits.length > 0 ? 'status.memory' : 'status.pagination')}</span>
          <label className={css.zoom}>
            <span>{t('status.zoom')}</span>
            <select aria-label={t('status.zoom')} value={zoom} onChange={(event) => {
              actions.setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))
            }}>
              <option value="fit">{t('status.fit')}</option>
              {[50, 75, 100, 125, 150, 200].map(value => <option key={value} value={value}>{value}%</option>)}
            </select>
          </label>
        </footer>
      )}
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
