/** Flat DSH-native PaperAI resource sections rendered in one Workspace detail. */

import {
  useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react'
import clsx from 'clsx'
import {
  Button, IconBrowseOutline16, IconChecklistOutline14, IconCodeOutline16,
  IconChevronDownOutline14, IconChevronRightOutline14, IconDataOutline16, IconFolderClose16,
  IconPlusOutline16, IconRefreshOutline14, IconSkillOutline16, Menu, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PaperAIActionResult, PaperAIDocumentRole, PaperAIResourceCategory, PaperAIResourceRow,
  PaperAIResourceStatus, PaperAITemplatePackChoice, PaperAITemplatePackMemberChoice,
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

/** Which start gesture the next browser file selection belongs to. */
type StartIntent =
  | { readonly kind: 'free'; readonly role: PaperAIDocumentRole }
  | { readonly kind: 'template'; readonly packId: string; readonly memberId: string }

const FREE_START = 'free'

function memberKey(packId: string, memberId: string): string {
  return `${packId}/${memberId}`
}

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

/** One built-in pack member as a start action: form templates create, references format an upload. */
function TemplateStartRow({ member, running, disabled, start, t }: {
  member: PaperAITemplatePackMemberChoice
  running: boolean
  disabled: boolean
  start: () => void
  t: PaperAIWorkspaceContentProps['t']
}): ReactNode {
  const creates = member.usage === 'form-template'
  return (
    <button
      type="button"
      className={clsx(css.resourceRow, css.resourceAction, css.startRow)}
      disabled={disabled}
      aria-label={t(creates ? 'start.createAria' : 'start.formatAria', { name: member.name })}
      title={member.description}
      onClick={start}
    >
      <span className={css.resourceIcon} aria-hidden="true">
        {creates ? <IconSkillOutline16 size={14} /> : <IconBrowseOutline16 size={14} />}
      </span>
      <span className={css.resourceName}>{member.name}</span>
      <span className={css.startVerb}>
        {running ? t('start.creating') : t(creates ? 'start.create' : 'start.format')}
      </span>
    </button>
  )
}

/** Render one additive PaperAI resource tree headed by the template-first start flow. */
export function WorkspaceContent({
  workspaceId, useResources, ensureResources, refreshResources, openResource,
  importDocument, createFromTemplate, loadTemplateChoices, t,
}: PaperAIWorkspaceContentProps): ReactNode {
  const fileInput = useRef<HTMLInputElement>(null)
  const intent = useRef<StartIntent | null>(null)
  const [role, setRole] = useState<PaperAIDocumentRole>('manuscript')
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [packs, setPacks] = useState<readonly PaperAITemplatePackChoice[] | null>(null)
  const [packsFailed, setPacksFailed] = useState(false)
  const [startOpen, setStartOpen] = useState<boolean | null>(null)
  const state = useResources(directory => directory.workspaces[workspaceId] ?? EMPTY_RESOURCES)

  useEffect(() => {
    void ensureResources(workspaceId)
  }, [ensureResources, workspaceId])

  const loadPacks = useCallback(async (): Promise<void> => {
    setPacksFailed(false)
    const result = await loadTemplateChoices(workspaceId)
    if (result.ok) setPacks(result.packs)
    else setPacksFailed(true)
  }, [loadTemplateChoices, workspaceId])

  useEffect(() => {
    void loadPacks()
  }, [loadPacks])

  // The start flow leads until the project holds a document; afterwards the
  // tree is what the sidebar is for and the flow folds behind its heading.
  const hasDocuments = state.resources.some(row => row.category === 'document')
  const settled = state.phase === 'ready' || state.phase === 'error'
  const open = startOpen ?? (settled && !hasDocuments)
  const busy = running !== null

  const run = async (key: string, action: () => Promise<PaperAIActionResult>, failure: PaperAIWorkbenchKey) => {
    setRunning(key)
    setStartError(null)
    try {
      const result = await action()
      if (!result.ok) setStartError(t(failure))
    } catch {
      setStartError(t('import.invalid'))
    } finally {
      setRunning(null)
    }
  }

  const selectWord = async (file: File): Promise<void> => {
    const chosen = intent.current ?? { kind: 'free', role }
    intent.current = null
    if (chosen.kind === 'free') {
      await run(FREE_START, async () => importDocument(workspaceId, {
        fileName: file.name,
        contentBase64: await readWordFileBase64(file),
        role: chosen.role,
      }), 'import.failed')
      return
    }
    await run(memberKey(chosen.packId, chosen.memberId), async () => createFromTemplate(workspaceId, {
      packId: chosen.packId,
      memberId: chosen.memberId,
      upload: { fileName: file.name, contentBase64: await readWordFileBase64(file) },
    }), 'start.failed')
  }

  const startMember = (pack: PaperAITemplatePackChoice, member: PaperAITemplatePackMemberChoice): void => {
    if (member.usage === 'form-template') {
      void run(memberKey(pack.packId, member.memberId), () => createFromTemplate(workspaceId, {
        packId: pack.packId,
        memberId: member.memberId,
      }), 'start.failed')
      return
    }
    intent.current = { kind: 'template', packId: pack.packId, memberId: member.memberId }
    fileInput.current?.click()
  }

  return (
    <div className={css.tree} aria-busy={state.phase === 'loading'}>
      <div className={css.sectionTitle}>
        <span className={css.sectionTitleIcon} aria-hidden="true"><IconFolderClose16 /></span>
        <h3>{t('tree.title')}</h3>
      </div>
      <section className={css.start} aria-label={t('start.title')}>
        <button
          type="button"
          className={css.startHeading}
          aria-expanded={open}
          onClick={() => { setStartOpen(!open) }}
        >
          <span className={css.startChevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
          <span>{t('start.title')}</span>
        </button>
        {open && (
          <>
            {packs === null && !packsFailed && (
              <p className={css.message} aria-live="polite">{t('start.loading')}</p>
            )}
            {packsFailed && (
              <div className={css.failure} role="alert">
                <span>{t('start.error')}</span>
                <Button
                  variant="toolbar"
                  size="sm"
                  icon={<IconRefreshOutline14 />}
                  onClick={() => { void loadPacks() }}
                >
                  {t('tree.retry')}
                </Button>
              </div>
            )}
            {packs?.map(pack => (
              <div className={css.pack} key={pack.packId}>
                <div className={css.packName} title={pack.description}>{pack.name}</div>
                {pack.members.map(member => (
                  <TemplateStartRow
                    key={member.memberId}
                    member={member}
                    running={running === memberKey(pack.packId, member.memberId)}
                    disabled={busy}
                    start={() => { startMember(pack, member) }}
                    t={t}
                  />
                ))}
              </div>
            ))}
            <div className={css.packName}>{t('start.free')}</div>
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
                    aria-label={t('import.roleAria', { role: t(ROLE_KEYS[role]) })}
                    aria-haspopup="menu"
                    aria-expanded={roleMenuOpen}
                    disabled={busy}
                    onClick={() => { setRoleMenuOpen(menuOpen => !menuOpen) }}
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
              <button
                type="button"
                className={css.importAction}
                disabled={busy}
                onClick={() => {
                  intent.current = { kind: 'free', role }
                  fileInput.current?.click()
                }}
              >
                <IconPlusOutline16 />
                <span>{running === FREE_START ? t('import.importing') : t('import.word')}</span>
              </button>
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
            if (file !== undefined) void selectWord(file).finally(() => { input.value = '' })
          }}
        />
        {startError !== null && <p className={css.inlineError} role="alert">{startError}</p>}
      </section>
      {(state.phase === 'cold' || (state.phase === 'loading' && state.resources.length === 0)) && (
        <p className={css.message} aria-live="polite">{t('tree.loading')}</p>
      )}
      {state.phase === 'error' && (
        <div className={css.failure} role="alert">
          <span>{t('tree.error')}</span>
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
      {/* The empty row carries no glyph: the section heading above already has one. */}
      {state.phase === 'ready' && state.resources.length === 0 && (
        <div className={css.projectEmpty} role="status">
          <span>{t('tree.empty')}</span>
        </div>
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
