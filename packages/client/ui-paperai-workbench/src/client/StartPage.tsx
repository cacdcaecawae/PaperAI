/**
 * The project start page, occupying the blank-session headline: the project's
 * template set and the ways to create or import a document. Without a
 * project it offers to create one.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconPlusOutline16, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PaperAIDocumentType, PaperAIFormatChoice, PaperAIProjectState, PaperAIWordUpload } from './types.ts'
import type { PaperAIStartPageProps } from './slots.ts'
import { readWordFileBase64 } from './browser-file.ts'
import { TemplateDialog } from './TemplateLibrary.tsx'
import { DOCUMENT_TYPE_KEYS, DOCUMENT_TYPE_ORDER } from './locales.ts'
import css from './StartPage.module.css'

const PROJECT_EMPTY: PaperAIProjectState = Object.freeze({
  phase: 'cold' as const, overview: null, selected: null, error: null, action: null, actionError: null,
})

/** Which gesture the next file selection belongs to. */
type UploadIntent =
  | { readonly kind: 'free' }
  | { readonly kind: 'format'; readonly documentType: PaperAIDocumentType }

/** Formats in thesis order, one button each. */
function orderedFormats(formats: readonly PaperAIFormatChoice[]): PaperAIFormatChoice[] {
  return [...formats].sort((left, right) => (
    DOCUMENT_TYPE_ORDER.indexOf(left.documentType) - DOCUMENT_TYPE_ORDER.indexOf(right.documentType)
  ))
}

/** Render the start page for the blank session's project. */
export function StartPage({
  sessionId, workspaceId, openWorkspacePicker, useProjects, useLibrary, renderSlot,
  ensureProject, setProjectTemplate, createFromTemplate, importDocument,
  loadLibrary, createTemplateSet, deleteTemplateSet, addTemplateFormat, removeTemplateFormat, t,
}: PaperAIStartPageProps): ReactNode {
  const project = useProjects(directory => (
    workspaceId === undefined ? PROJECT_EMPTY : directory.workspaces[workspaceId] ?? PROJECT_EMPTY
  ))
  const library = useLibrary(value => value)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [invalidFile, setInvalidFile] = useState(false)
  const prompted = useRef(new Set<WorkspaceId>())
  const intent = useRef<UploadIntent | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const overview = project.overview

  useEffect(() => {
    if (workspaceId !== undefined) void ensureProject(workspaceId)
  }, [ensureProject, workspaceId])

  // A project that never decided its template is asked once per visit; a
  // closed dialog is an answer for this visit, not a reason to nag.
  useEffect(() => {
    if (workspaceId === undefined || overview === null || overview.templateDecided || prompted.current.has(workspaceId)) return
    prompted.current.add(workspaceId)
    setDialogOpen(true)
  }, [workspaceId, overview])

  useEffect(() => {
    if (dialogOpen) void loadLibrary()
  }, [dialogOpen, loadLibrary])

  const mark = renderSlot('paperai.start.mark', { size: 34, className: css.mark }, { fallback: null })

  if (workspaceId === undefined || sessionId === undefined) {
    return (
      <div className={css.root} data-paperai-start="no-project">
        <div className={css.headline}>
          <span className={css.markSeat} aria-hidden="true">{mark}</span>
          <span className={css.headlineText}>PaperAI</span>
        </div>
        <p className={css.lead}>{t('start.noProject')}</p>
        <div className={css.actions}>
          <Button variant="outline" icon={<IconPlusOutline16 />} onClick={openWorkspacePicker}>
            {t('start.addProject')}
          </Button>
        </div>
      </div>
    )
  }

  const busy = project.action !== null
  const selectFile = async (file: File): Promise<void> => {
    const chosen = intent.current ?? { kind: 'free' }
    intent.current = null
    setInvalidFile(false)
    let upload: PaperAIWordUpload
    try {
      upload = { fileName: file.name, contentBase64: await readWordFileBase64(file) }
    } catch {
      setInvalidFile(true)
      return
    }
    if (chosen.kind === 'free') await importDocument(workspaceId, upload)
    else await createFromTemplate(workspaceId, { documentType: chosen.documentType, upload })
  }
  const startFormat = (format: PaperAIFormatChoice): void => {
    if (format.usage === 'form-template') {
      void createFromTemplate(workspaceId, { documentType: format.documentType })
      return
    }
    intent.current = { kind: 'format', documentType: format.documentType }
    fileInput.current?.click()
  }

  const templateLine = overview === null
    ? null
    : overview.template !== null
      ? t('start.template', { name: overview.template.name })
      : overview.templatePackId !== null
        ? t('start.templateMissing')
        : overview.templateDecided
          ? t('start.templateNone')
          : t('start.templateUndecided')
  const formats = orderedFormats(overview?.template?.formats ?? [])

  return (
    <div className={css.root} data-paperai-start="project">
      <div className={css.headline}>
        <span className={css.markSeat} aria-hidden="true">{mark}</span>
        <span className={css.headlineText}>{overview?.projectName ?? ''}</span>
      </div>
      {project.phase === 'error' && overview === null && (
        <div className={css.failure} role="alert">
          <span>{t('start.error')}</span>
          <Button variant="toolbar" size="sm" icon={<IconRefreshOutline14 />} onClick={() => { void ensureProject(workspaceId) }}>
            {t('start.retry')}
          </Button>
        </div>
      )}
      {overview === null && project.phase !== 'error' && (
        <p className={css.lead} aria-live="polite">{t('start.loading')}</p>
      )}
      {overview !== null && (
        <>
          <p className={css.templateLine}>
            <span>{templateLine}</span>
            <button
              type="button"
              className={css.changeTemplate}
              disabled={busy}
              onClick={() => { setDialogOpen(true) }}
            >
              {t(overview.templateDecided ? 'start.change' : 'start.choose')}
            </button>
          </p>
          <div className={css.actions}>
            {formats.map((format) => {
              const type = t(DOCUMENT_TYPE_KEYS[format.documentType])
              const creates = format.usage === 'form-template'
              return (
                <Button
                  key={`${format.memberId}:${format.documentType}`}
                  variant="outline"
                  disabled={busy}
                  aria-label={t(creates ? 'start.newAria' : 'start.importFormatAria', { type })}
                  onClick={() => { startFormat(format) }}
                >
                  {busy && project.action === 'starting'
                    ? t('start.working')
                    : t(creates ? 'start.new' : 'start.importFormat', { type })}
                </Button>
              )
            })}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                intent.current = { kind: 'free' }
                fileInput.current?.click()
              }}
            >
              {t('start.importFree')}
            </Button>
          </div>
        </>
      )}
      <input
        ref={fileInput}
        className={css.visuallyHidden}
        type="file"
        aria-hidden="true"
        accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        tabIndex={-1}
        onChange={(event) => {
          const input = event.currentTarget
          const file = input.files?.[0]
          if (file !== undefined) void selectFile(file).finally(() => { input.value = '' })
        }}
      />
      {invalidFile && <p className={css.error} role="alert">{t('start.invalidFile')}</p>}
      {project.actionError !== null && <p className={css.error} role="alert">{t('start.failed')}</p>}
      <TemplateDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false) }}
        state={library}
        project={{
          packId: overview?.templatePackId ?? null,
          decided: overview?.templateDecided ?? false,
          choosing: project.action === 'choosing-template',
          choose: async (packId) => {
            const result = await setProjectTemplate(workspaceId, packId)
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
    </div>
  )
}
