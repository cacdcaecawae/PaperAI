/** The project's tracked documents, listed under the sidebar's project detail. */

import { useEffect, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconBrowseOutline16, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIDocumentRow, PaperAIProjectState } from './types.ts'
import type { PaperAIWorkspaceContentProps } from './slots.ts'
import { DOCUMENT_TYPE_KEYS } from './locales.ts'
import css from './WorkspaceContent.module.css'
import { ProjectDoctor } from './ProjectDoctor.tsx'

const PROJECT_EMPTY: PaperAIProjectState = Object.freeze({
  phase: 'cold' as const, overview: null, selected: null, error: null, action: null, actionError: null,
})

/** One tracked document as a row in the DSH session-row idiom. */
function DocumentRow({ row, selected, open, t }: {
  row: PaperAIDocumentRow
  selected: boolean
  open: () => void
  t: PaperAIWorkspaceContentProps['t']
}): ReactNode {
  return (
    <button
      type="button"
      className={clsx(css.row, selected && css.selected)}
      aria-current={selected ? 'true' : undefined}
      aria-label={t('documents.open', { name: row.fileName })}
      title={row.fileName}
      onClick={open}
    >
      <span className={css.slot} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
      <span className={css.title}>{row.name}</span>
      {row.documentType !== 'other' && (
        <span className={css.meta}>{t(DOCUMENT_TYPE_KEYS[row.documentType])}</span>
      )}
    </button>
  )
}

/** Render the document list for one project. */
export function WorkspaceContent({
  workspaceId, useProjects, useDiagnostics, inspectProject, ensureProject, refreshProject, openDocument, t,
}: PaperAIWorkspaceContentProps): ReactNode {
  const state = useProjects(directory => directory.workspaces[workspaceId] ?? PROJECT_EMPTY)
  const diagnostics = useDiagnostics(value => value.projects[workspaceId])

  useEffect(() => {
    void ensureProject(workspaceId)
  }, [ensureProject, workspaceId])

  const documents = state.overview?.documents ?? []
  const loading = state.overview === null && (state.phase === 'cold' || state.phase === 'loading')
  return (
    <section className={css.section} aria-label={t('documents.title')} aria-busy={state.phase === 'loading'}>
      <div className={css.heading}>
        <span className={css.headingIcon} aria-hidden="true"><IconBrowseOutline16 /></span>
        <h3>{t('documents.title')}</h3>
        {documents.length > 0 && <span className={css.count}>{documents.length}</span>}
      </div>
      {loading && <p className={css.message} aria-live="polite">{t('documents.loading')}</p>}
      {state.phase === 'error' && (
        <div className={css.failure} role="alert">
          <span>{t('documents.error')}</span>
          <Button
            variant="toolbar"
            size="sm"
            icon={<IconRefreshOutline14 />}
            onClick={() => { void refreshProject(workspaceId) }}
          >
            {t('documents.retry')}
          </Button>
        </div>
      )}
      {state.phase === 'ready' && documents.length === 0 && (
        <div className={css.empty} role="status">{t('documents.empty')}</div>
      )}
      {documents.length > 0 && (
        <div className={css.list} role="list" aria-label={t('documents.title')}>
          {documents.map(row => (
            <div role="listitem" key={row.id}>
              <DocumentRow
                row={row}
                selected={state.selected === row.id}
                open={() => { void openDocument(workspaceId, row.id) }}
                t={t}
              />
            </div>
          ))}
        </div>
      )}
      <ProjectDoctor key={workspaceId} state={diagnostics} inspect={plan => inspectProject(workspaceId, plan)} t={t} />
    </section>
  )
}
