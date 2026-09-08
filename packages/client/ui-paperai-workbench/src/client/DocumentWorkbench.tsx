/** The document view: the document itself, a toolbar of secondary entries, and one open panel. */

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, DetailsViewShell, IconChevronDownOutline14, IconDownloadOutline16, IconFullscreenOutline16,
  IconRefreshOutline14, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIDocumentSnapshot, PaperAIExportMode, PaperAIWorkbenchPanel, PaperAIWorkbenchState } from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import { DocumentPreview } from './DocumentPreview.tsx'
import { fixPromptText, GatePanel, TemplatePanel, VersionsPanel } from './panels.tsx'
import { TemplateDialog } from './TemplateLibrary.tsx'
import type { PaperAIWorkbenchKey } from './locales.ts'
import css from './DocumentWorkbench.module.css'

type Translate = PaperAIDocumentWorkbenchProps['t']

const EXPORT_MODES: readonly PaperAIExportMode[] = ['draft-export', 'delivery-export']

/** Actionable controller failures have specific guidance; other failures offer a retry. */
function actionErrorKey(error: string): PaperAIWorkbenchKey {
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
      {chip('template', document.template?.name ?? t('toolbar.templateNone'), {
        'data-attached': document.template !== null ? 'true' : 'false',
        title: t('toolbar.template'),
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
      {chip('versions', t('toolbar.versions', { count: document.versions.length }))}
      <Menu
        compact
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
            disabled={busy}
            onClick={() => { setExportOpen(open => !open) }}
          >
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
        title={t(focusActive ? 'workbench.focusExit' : 'workbench.focus')}
        onClick={toggleFocus}
      >
        <IconFullscreenOutline16 size={14} />
        <span>{t(focusActive ? 'workbench.focusExit' : 'workbench.focus')}</span>
      </button>
    </div>
  )
}

/** Render the PaperAI full-column details contribution. */
export function DocumentWorkbench({
  closeDetails, setDraft, useWorkbench, useProjects, useLibrary, quoteSelection, setScroll,
  retryOpen, showPanel, selectBlock, updateDraft, cancelEdit, commitEdit, validate, suggestType,
  applyTemplate, detachTemplate, setProjectTemplate, showDiff, restore, exportDocument, reloadExternal,
  setDetailsFocus, loadLibrary, createTemplateSet, deleteTemplateSet, addTemplateFormat, removeTemplateFormat, t,
}: PaperAIDocumentWorkbenchProps): ReactNode {
  const state = useWorkbench(value => value)
  const document = state.document
  const overview = useProjects(directory => (
    document === null ? null : directory.workspaces[document.workspaceId]?.overview ?? null
  ))
  const library = useLibrary(value => value)
  const [focusActive, setFocusActive] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [blockNotice, setBlockNotice] = useState<PaperAIWorkbenchKey | null>(null)
  // Unmount releases a still-active focus demand so the split returns.
  useEffect(() => () => { setDetailsFocus(false) }, [setDetailsFocus])
  // A block notice answers one click. Once the workbench moves on — another
  // block opened or closed, an action settled, a new revision arrives — the
  // reason it named is gone, so the line goes with it.
  const editingNodeId = state.edit?.nodeId ?? null
  useEffect(() => { setBlockNotice(null) }, [document?.documentId, document?.revision, editingNodeId, state.action])
  useEffect(() => {
    if (dialogOpen) void loadLibrary()
  }, [dialogOpen, loadLibrary])
  const toggleFocus = (): void => {
    const next = !focusActive
    setFocusActive(next)
    setDetailsFocus(next)
  }
  const receiptKey: PaperAIWorkbenchKey | null = state.exportReceipt === null
    ? null
    : state.exportReceipt.mode === 'draft-export' ? 'export.draftDone' : 'export.deliveryDone'

  return (
    <DetailsViewShell
      className={css.root ?? ''}
      title={document?.title ?? t('workbench.title')}
      {...document === null ? {} : { subtitle: document.path }}
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
          focusActive={focusActive}
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
      {state.actionError !== null && (
        <p className={css.actionError} role="alert">{t(actionErrorKey(state.actionError))}</p>
      )}
      {blockNotice !== null && (
        <p className={css.actionError} role="status">{t(blockNotice)}</p>
      )}
      <main className={css.body}>
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
                html={view.document.previewHtml}
                nodes={view.document.nodes}
                active={view === state}
                scrollTop={view.scrollTop}
                onScroll={setScroll}
                onQuote={(excerpt) => { if (view.document !== null) quoteSelection(view.document, excerpt) }}
                title={t('preview.title')}
                editing={view.edit}
                saving={state.action === 'committing'}
                onSelectBlock={(nodeId) => {
                  if (nodeId === null) {
                    setBlockNotice('block.unmapped')
                    return
                  }
                  const result = selectBlock(nodeId)
                  setBlockNotice(result.ok ? null : 'block.busy')
                }}
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
            onSendFix={() => { setDraft(fixPromptText(document, t)) }}
            onClose={() => { showPanel(null) }}
            t={t}
          />
        )}
        {state.phase === 'ready' && document !== null && state.panel === 'versions' && (
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
