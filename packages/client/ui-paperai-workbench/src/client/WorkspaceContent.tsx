/** Flat DSH-native PaperAI tree rendered below one expanded Workspace. */

import {
  useEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react'
import clsx from 'clsx'
import {
  Button, IconBrowseOutline16, IconChecklistOutline14, IconCodeOutline16,
  IconChevronDownOutline14, IconDataOutline16, IconFolderClose16, IconPlusOutline16,
  IconRefreshOutline14, IconSkillOutline16, Menu, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PaperAIDocumentRole, PaperAIResourceCategory, PaperAIResourceRow, PaperAIResourceStatus,
} from './types.ts'
import { readWordFileBase64 } from './browser-file.ts'
import type { PaperAIWorkspaceContentProps } from './slots.ts'
import type { PaperAIWorkbenchKey } from './locales.ts'
import css from './WorkspaceContent.module.css'

const CATEGORIES: readonly PaperAIResourceCategory[] = [
  'document', 'template', 'image', 'experiment', 'code',
]

const EMPTY_RESOURCES = Object.freeze({
  phase: 'cold' as const, resources: [], selected: null, error: null,
})

const STATUS_DOTS = {
  clean: 'done',
  modified: 'warning',
  pending: 'ongoing',
  blocked: 'error',
} satisfies Record<PaperAIResourceStatus, StateDotState>

const CATEGORY_KEYS = {
  document: 'category.document',
  template: 'category.template',
  image: 'category.image',
  experiment: 'category.experiment',
  code: 'category.code',
} satisfies Record<PaperAIResourceCategory, PaperAIWorkbenchKey>

const STATUS_KEYS = {
  clean: 'status.clean',
  modified: 'status.modified',
  pending: 'status.pending',
  blocked: 'status.blocked',
} satisfies Record<PaperAIResourceStatus, PaperAIWorkbenchKey>

const DOCUMENT_ROLES: readonly PaperAIDocumentRole[] = [
  'manuscript', 'proposal', 'midterm', 'final', 'other',
]

const ROLE_KEYS = {
  manuscript: 'role.manuscript',
  proposal: 'role.proposal',
  midterm: 'role.midterm',
  final: 'role.final',
  other: 'role.other',
} satisfies Record<PaperAIDocumentRole, PaperAIWorkbenchKey>

/** Category icon using the shared DSH icon vocabulary. */
function CategoryIcon({ category }: { category: PaperAIResourceCategory }): ReactNode {
  switch (category) {
    case 'document': return <IconBrowseOutline16 size={14} />
    case 'template': return <IconSkillOutline16 size={14} />
    case 'image': return <IconDataOutline16 size={14} />
    case 'experiment': return <IconChecklistOutline14 size={14} />
    case 'code': return <IconCodeOutline16 size={14} />
  }
}

/** Render one row as an action only when the Host declares it openable. */
function ResourceRow({ row, selected, open, t }: {
  row: PaperAIResourceRow
  selected: boolean
  open: () => void
  t: PaperAIWorkspaceContentProps['t']
}): ReactNode {
  const depthStyle = {
    '--paperai-resource-indent': `${8 + Math.max(0, Math.min(8, row.depth)) * 14}px`,
  } as CSSProperties
  const content = (
    <>
      <span className={css.resourceIcon} aria-hidden="true">
        {row.kind === 'folder' ? <IconFolderClose16 size={14} /> : <IconTreeFile category={row.category} />}
      </span>
      <span className={css.resourceName} title={row.path}>{row.name}</span>
      {row.status !== undefined && (
        <span className={css.resourceStatus} title={t(STATUS_KEYS[row.status])}>
          <StateDot state={STATUS_DOTS[row.status]} size={8} />
          <span className={css.visuallyHidden}>{t(STATUS_KEYS[row.status])}</span>
        </span>
      )}
    </>
  )
  return row.openable ? (
    <button
      type="button"
      className={clsx(css.resourceRow, css.resourceAction)}
      style={depthStyle}
      data-selected={selected ? 'true' : undefined}
      aria-label={t('resource.open', { name: row.name })}
      onClick={open}
    >
      {content}
    </button>
  ) : (
    <div className={css.resourceRow} style={depthStyle} data-resource-kind={row.kind}>
      {content}
    </div>
  )
}

/** File glyph chosen from the shared category vocabulary. */
function IconTreeFile({ category }: { category: PaperAIResourceCategory }): ReactNode {
  return category === 'code'
    ? <IconCodeOutline16 size={14} />
    : category === 'template'
      ? <IconSkillOutline16 size={14} />
      : <IconBrowseOutline16 size={14} />
}

/** Render one additive PaperAI resource tree. */
export function WorkspaceContent({
  workspaceId, useResources, ensureResources, refreshResources, openResource, importDocument, t,
}: PaperAIWorkspaceContentProps): ReactNode {
  const fileInput = useRef<HTMLInputElement>(null)
  const [role, setRole] = useState<PaperAIDocumentRole>('manuscript')
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const state = useResources(directory => directory.workspaces[workspaceId] ?? EMPTY_RESOURCES)

  useEffect(() => {
    void ensureResources(workspaceId)
  }, [ensureResources, workspaceId])

  const selectWord = async (file: File): Promise<void> => {
    setImporting(true)
    setImportError(null)
    try {
      const result = await importDocument(workspaceId, {
        fileName: file.name,
        contentBase64: await readWordFileBase64(file),
        role,
      })
      if (!result.ok) setImportError(result.error)
    } catch {
      setImportError(t('import.invalid'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={css.tree} aria-busy={state.phase === 'loading'}>
      <div className={css.importBar}>
        <Menu
          compact
          open={roleMenuOpen}
          selectedId={role}
          items={DOCUMENT_ROLES.map(value => ({ id: value, label: t(ROLE_KEYS[value]) }))}
          anchor={(
            <button
              type="button"
              className={css.roleSelect}
              aria-label={t('import.role')}
              aria-expanded={roleMenuOpen}
              disabled={importing}
              onClick={() => { setRoleMenuOpen(open => !open) }}
            >
              <span>{t(ROLE_KEYS[role])}</span>
              <IconChevronDownOutline14 />
            </button>
          )}
          onSelect={(value) => {
            setRole(value as PaperAIDocumentRole)
            setRoleMenuOpen(false)
          }}
          onClose={() => { setRoleMenuOpen(false) }}
        />
        <input
          ref={fileInput}
          className={css.visuallyHidden}
          type="file"
          accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          tabIndex={-1}
          onChange={(event) => {
            const input = event.currentTarget
            const file = input.files?.[0]
            if (file !== undefined) void selectWord(file).finally(() => { input.value = '' })
          }}
        />
        <Button
          variant="toolbar"
          size="sm"
          icon={<IconPlusOutline16 />}
          disabled={importing}
          onClick={() => { fileInput.current?.click() }}
        >
          {importing ? t('import.importing') : t('import.word')}
        </Button>
      </div>
      {importError !== null && <p className={css.inlineError} role="alert">{importError}</p>}
      {(state.phase === 'cold' || (state.phase === 'loading' && state.resources.length === 0)) && (
        <p className={css.message} aria-live="polite">{t('tree.loading')}</p>
      )}
      {state.phase === 'error' && (
        <div className={css.failure} role="alert">
          <span>{state.error ?? t('tree.error')}</span>
          <Button
            variant="toolbar"
            size="sm"
            icon={<IconRefreshOutline14 />}
            onClick={() => { void refreshResources(workspaceId) }}
          >
            {t('tree.retry')}
          </Button>
        </div>
      )}
      {state.phase === 'ready' && state.resources.length === 0 && (
        <p className={css.projectEmpty}>{t('tree.empty')}</p>
      )}
      {CATEGORIES.filter(category => state.resources.some(row => row.category === category)).map((category) => {
        const rows = state.resources.filter(row => row.category === category)
        return (
          <section className={css.group} key={category} aria-label={t(CATEGORY_KEYS[category])}>
            <div className={css.groupHeading}>
              <span className={css.groupIcon} aria-hidden="true"><CategoryIcon category={category} /></span>
              <span>{t(CATEGORY_KEYS[category])}</span>
              <span className={css.count}>{rows.length}</span>
            </div>
            {rows.map(row => (
              <ResourceRow
                key={row.id}
                row={row}
                selected={state.selected === row.id}
                t={t}
                open={() => { void openResource(workspaceId, row.id) }}
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}
