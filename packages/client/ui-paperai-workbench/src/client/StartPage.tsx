/**
 * The project start page, occupying the blank-session headline: the mark, the
 * project name with one line of facts, its tracked documents, and one row that
 * creates or imports a document. Without a project it offers to create one.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconBrowseOutline16, IconPlusOutline16, IconRefreshOutline14, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIDocumentType, PaperAIFormatChoice, PaperAIProjectState, PaperAIWordUpload } from './types.ts'
import type { PaperAIStartPageProps } from './slots.ts'
import { readWordFileBase64 } from './browser-file.ts'
import { TemplateDialog } from './TemplateLibrary.tsx'
import { DOCUMENT_TYPE_KEYS, DOCUMENT_TYPE_ORDER } from './locales.ts'
import { typeAccent } from './type-accent.ts'
import css from './StartPage.module.css'

const PROJECT_EMPTY: PaperAIProjectState = Object.freeze({
  phase: 'cold' as const, overview: null, selected: null, error: null, action: null, actionError: null,
})

/** Which gesture the next file selection belongs to. */
type UploadIntent =
  | { readonly kind: 'free' }
  | { readonly kind: 'format'; readonly documentType: PaperAIDocumentType }

/** Formats in thesis order, one menu row each. */
function orderedFormats(formats: readonly PaperAIFormatChoice[]): PaperAIFormatChoice[] {
  return [...formats].sort((left, right) => (
    DOCUMENT_TYPE_ORDER.indexOf(left.documentType) - DOCUMENT_TYPE_ORDER.indexOf(right.documentType)
  ))
}

/** The menu row id of one format; the free import is the row after them. */
function formatId(format: PaperAIFormatChoice): string {
  return `${format.usage}:${format.documentType}`
}

/** Midnight of a date's calendar day, for whole-day distances. */
function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** "Today" or "yesterday" in the browser's language, otherwise the calendar day; the year only when it is not this one. */
function dayOf(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const daysAgo = Math.round((dayStart(now) - dayStart(date)) / 86_400_000)
  if (daysAgo === 0 || daysAgo === 1) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-daysAgo, 'day')
  const thisYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(undefined, { ...(thisYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric' })
}

/** Render the start page for the blank session's project. */
export function StartPage({
  sessionId, workspaceId, openWorkspacePicker, useProjects, useLibrary, renderSlot,
  ensureProject, setProjectTemplate, createFromTemplate, importDocument, openDocument,
  loadLibrary, createTemplateSet, deleteTemplateSet, addTemplateFormat, removeTemplateFormat, t,
}: PaperAIStartPageProps): ReactNode {
  const project = useProjects(directory => (
    workspaceId === undefined ? PROJECT_EMPTY : directory.workspaces[workspaceId] ?? PROJECT_EMPTY
  ))
  const library = useLibrary(value => value)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [invalidFile, setInvalidFile] = useState(false)
  const intent = useRef<UploadIntent | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const overview = project.overview

  useEffect(() => {
    if (workspaceId !== undefined) void ensureProject(workspaceId)
  }, [ensureProject, workspaceId])

  useEffect(() => {
    if (dialogOpen) void loadLibrary()
  }, [dialogOpen, loadLibrary])

  const mark = <span className={css.markSeat} aria-hidden="true">{renderSlot('paperai.start.mark', { size: 40, className: css.mark }, { fallback: null })}</span>

  if (workspaceId === undefined || sessionId === undefined) {
    return (
      <div className={css.root} data-paperai-start="no-project">
        <div className={css.headline}>
          {mark}
          <h1 className={css.title}>PaperAI</h1>
          <p className={css.lead}>{t('start.noProject')}</p>
        </div>
        <Button variant="outline" icon={<IconPlusOutline16 />} onClick={openWorkspacePicker}>
          {t('start.addProject')}
        </Button>
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
  const formats = orderedFormats(overview?.template?.formats ?? [])
  const start = (id: string): void => {
    setMenuOpen(false)
    const format = formats.find(candidate => formatId(candidate) === id)
    if (format?.usage === 'form-template') {
      void createFromTemplate(workspaceId, { documentType: format.documentType })
      return
    }
    intent.current = format === undefined ? { kind: 'free' } : { kind: 'format', documentType: format.documentType }
    fileInput.current?.click()
  }

  const templateLabel = overview === null
    ? ''
    : overview.template !== null
      ? overview.template.name
      : overview.templatePackId !== null
        ? t('start.templateMissing')
        : overview.templateDecided
          ? t('start.templateNone')
          : t('start.templateUndecided')
  const documents = overview?.documents ?? []
  const latest = documents.reduce<string | null>((newest, row) => (
    newest === null || row.updatedAt > newest ? row.updatedAt : newest
  ), null)
  const items = [
    ...formats.map(format => ({
      id: formatId(format),
      label: t(format.usage === 'form-template' ? 'start.new' : 'start.importFormat', { type: t(DOCUMENT_TYPE_KEYS[format.documentType]) }),
    })),
    { id: 'free', label: t('start.importFree') },
  ]

  return (
    <div className={css.root} data-paperai-start="project">
      <div className={css.headline}>
        {mark}
        <h1 className={css.title} title={overview?.projectName}>{overview?.projectName ?? ''}</h1>
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
          <p className={css.facts}>
            <button
              type="button"
              className={css.templateLink}
              disabled={busy}
              aria-label={overview.template === null ? undefined : t('start.template', { name: overview.template.name })}
              onClick={() => { setDialogOpen(true) }}
            >
              {templateLabel}
            </button>
            <span aria-hidden="true">·</span>
            <span>{t('start.documentCount', { count: documents.length })}</span>
            {latest !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('start.edited', { date: dayOf(latest) })}</span>
              </>
            )}
          </p>
        )}
      </div>
      {overview !== null && (
        <div className={css.documents}>
          {documents.length === 0 && <p className={css.lead}>{t('start.empty')}</p>}
          {documents.length > 0 && (
            <>
              <div className={css.listHead} aria-hidden="true">
                <span>{t('documents.title')}</span>
                <span>{t('start.recent')}</span>
              </div>
              <div role="list" aria-label={t('documents.title')}>
                {documents.map(row => (
                  <div role="listitem" key={row.id}>
                    <button
                      type="button"
                      className={css.docRow}
                      style={typeAccent(row.documentType)}
                      aria-label={t('documents.open', { name: row.fileName })}
                      title={row.workingPath ?? row.fileName}
                      onClick={() => { void openDocument(workspaceId, row.id) }}
                    >
                      <span className={css.docIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                      <span className={css.docName}>{row.name}
                        {documents.some(other => other.id !== row.id && other.name === row.name) && (
                          <small>{row.fileName} · {row.documentId.slice(-8)}</small>
                        )}
                      </span>
                      {row.documentType !== 'other' && (
                        <span className={css.badge}>{t(DOCUMENT_TYPE_KEYS[row.documentType])}</span>
                      )}
                      <time className={css.docDate} dateTime={row.updatedAt}>{dayOf(row.updatedAt)}</time>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className={css.menu}>
            <Menu
              portal
              open={menuOpen}
              items={items}
              anchor={(
                <button
                  type="button"
                  className={css.createRow}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  disabled={busy}
                  onClick={() => { setMenuOpen(open => !open) }}
                >
                  <IconPlusOutline16 />
                  <span>{busy && project.action === 'starting' ? t('start.working') : t('start.create')}</span>
                </button>
              )}
              onSelect={start}
              onClose={() => { setMenuOpen(false) }}
            />
          </div>
        </div>
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
