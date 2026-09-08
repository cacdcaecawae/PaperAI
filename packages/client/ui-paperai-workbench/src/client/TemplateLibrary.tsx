/**
 * The template library: sets of formats, one per institution, each format
 * keyed by document type. One view serves the Templates settings page and the
 * project dialog; the dialog adds the "use for this project" decision.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutline14, IconChevronDownOutline14, IconPlusOutline16, IconRefreshOutline14,
  IconTrashOutline16, Input, Menu, Modal, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PaperAIActionResult, PaperAIDocumentType, PaperAILibraryState, PaperAITemplateSetChoice, PaperAITemplateUsage,
} from './types.ts'
import type { PaperAILibraryInjected, PaperAITemplatesSectionProps } from './slots.ts'
import { readWordFileBase64, wordStem } from './browser-file.ts'
import { DOCUMENT_TYPE_KEYS, DOCUMENT_TYPE_ORDER, USAGE_KEYS } from './locales.ts'
import css from './TemplateLibrary.module.css'

type Translate = PaperAITemplatesSectionProps['t']
type LibraryActions = Omit<PaperAILibraryInjected, 'hooks'>

/** The project whose template choice the library view can change. */
export interface TemplateLibraryProjectContext {
  /** Set the project uses; `null` when it writes freely or has not decided. */
  readonly packId: string | null
  /** Whether the project has decided (a `null` pack then means "no template"). */
  readonly decided: boolean
  readonly choosing: boolean
  readonly choose: (packId: string | null) => Promise<PaperAIActionResult>
}

/** Shared props of the library body. */
export interface TemplateLibraryViewProps extends LibraryActions {
  readonly state: PaperAILibraryState
  readonly project?: TemplateLibraryProjectContext | undefined
  readonly t: Translate
}

const USAGES: readonly PaperAITemplateUsage[] = ['form-template', 'format-reference']

/** Inline form that adds one format to a custom set: pick the type and usage, then the file. */
function AddFormatForm({ set, state, addTemplateFormat, close, t }: {
  set: PaperAITemplateSetChoice
  state: PaperAILibraryState
  addTemplateFormat: LibraryActions['addTemplateFormat']
  close: () => void
  t: Translate
}): ReactNode {
  const covered = new Set(set.formats.map(format => format.documentType))
  const [documentType, setDocumentType] = useState<PaperAIDocumentType>(
    DOCUMENT_TYPE_ORDER.find(type => !covered.has(type)) ?? 'proposal',
  )
  const [usage, setUsage] = useState<PaperAITemplateUsage>('form-template')
  const [typeOpen, setTypeOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = state.action !== null || reading

  const submit = async (file: File): Promise<void> => {
    setReading(true)
    setInvalid(false)
    try {
      const contentBase64 = await readWordFileBase64(file)
      const result = await addTemplateFormat({
        packId: set.packId, documentType, usage, name: wordStem(file.name), fileName: file.name, contentBase64,
      })
      if (result.ok) close()
    } catch {
      setInvalid(true)
    } finally {
      setReading(false)
    }
  }

  return (
    <div className={css.addFormat}>
      <Menu
        compact
        open={typeOpen}
        selectedId={documentType}
        items={DOCUMENT_TYPE_ORDER.map(type => ({ id: type, label: t(DOCUMENT_TYPE_KEYS[type]) }))}
        anchor={(
          <button
            type="button"
            className={css.select}
            aria-label={t('library.formatType')}
            aria-haspopup="menu"
            aria-expanded={typeOpen}
            disabled={busy}
            onClick={() => { setTypeOpen(open => !open) }}
          >
            <span>{t(DOCUMENT_TYPE_KEYS[documentType])}</span>
            <IconChevronDownOutline14 />
          </button>
        )}
        onSelect={(id) => {
          setDocumentType(id as PaperAIDocumentType)
          setTypeOpen(false)
        }}
        onClose={() => { setTypeOpen(false) }}
      />
      <Menu
        compact
        open={usageOpen}
        selectedId={usage}
        items={USAGES.map(value => ({
          id: value,
          label: t(value === 'form-template' ? 'library.usageForm' : 'library.usageReference'),
        }))}
        anchor={(
          <button
            type="button"
            className={css.select}
            aria-label={t('library.formatUsage')}
            aria-haspopup="menu"
            aria-expanded={usageOpen}
            disabled={busy}
            onClick={() => { setUsageOpen(open => !open) }}
          >
            <span>{t(usage === 'form-template' ? 'library.usageForm' : 'library.usageReference')}</span>
            <IconChevronDownOutline14 />
          </button>
        )}
        onSelect={(id) => {
          setUsage(id as PaperAITemplateUsage)
          setUsageOpen(false)
        }}
        onClose={() => { setUsageOpen(false) }}
      />
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
          if (file !== undefined) void submit(file).finally(() => { input.value = '' })
        }}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { fileInput.current?.click() }}>
        {busy ? t('library.working') : t('library.formatFile')}
      </Button>
      <Button variant="toolbar" size="sm" disabled={busy} onClick={close}>{t('library.cancel')}</Button>
      {invalid && <p className={css.error} role="alert">{t('start.invalidFile')}</p>}
    </div>
  )
}

/** One template set: identity, its formats, and the actions the set kind allows. */
function SetCard({ set, state, project, actions, t }: {
  set: PaperAITemplateSetChoice
  state: PaperAILibraryState
  project: TemplateLibraryProjectContext | undefined
  actions: LibraryActions
  t: Translate
}): ReactNode {
  const [addingFormat, setAddingFormat] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const busy = state.action !== null
  const current = project !== undefined && project.packId === set.packId
  const formats = [...set.formats].sort((left, right) => (
    DOCUMENT_TYPE_ORDER.indexOf(left.documentType) - DOCUMENT_TYPE_ORDER.indexOf(right.documentType)
  ))
  return (
    <li className={clsx(css.card, current && css.cardCurrent)}>
      <div className={css.cardHead}>
        <div className={css.identity}>
          <strong>{set.name}</strong>
          <Pill>{t(set.kind === 'built-in' ? 'library.builtIn' : 'library.custom')}</Pill>
        </div>
        <div className={css.cardActions}>
          {project !== undefined && (current
            ? (
              <span className={css.currentTag}>
                <IconCheckOutline14 />
                <span>{t('library.current')}</span>
              </span>
            )
            : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || project.choosing || set.formats.length === 0}
                onClick={() => { void project.choose(set.packId) }}
              >
                {t('library.use')}
              </Button>
            ))}
          {set.kind === 'custom' && (confirmingDelete
            ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className={css.danger}
                  disabled={busy}
                  onClick={() => { void actions.deleteTemplateSet(set.packId) }}
                >
                  {t('library.confirmDelete')}
                </Button>
                <Button variant="toolbar" size="sm" disabled={busy} onClick={() => { setConfirmingDelete(false) }}>
                  {t('library.cancel')}
                </Button>
              </>
            )
            : (
              <Button
                variant="toolbar"
                size="sm"
                icon={<IconTrashOutline16 />}
                aria-label={`${t('library.delete')}：${set.name}`}
                disabled={busy}
                onClick={() => { setConfirmingDelete(true) }}
              />
            ))}
        </div>
      </div>
      {set.description !== '' && <p className={css.description}>{set.description}</p>}
      <div className={css.formats}>
        <span className={css.formatsLabel}>{t('library.formats')}</span>
        {formats.length === 0 && <span className={css.noFormats}>{t('library.noFormats')}</span>}
        {formats.map((format) => {
          const typeLabel = t(DOCUMENT_TYPE_KEYS[format.documentType])
          return (
            <span className={css.format} key={`${format.memberId}:${format.documentType}`} title={format.originalFileName}>
              <strong>{typeLabel}</strong>
              <span>{t(USAGE_KEYS[format.usage])}</span>
              {set.kind === 'custom' && (
                <button
                  type="button"
                  className={css.formatRemove}
                  aria-label={`${t('library.formatRemove')}：${typeLabel}`}
                  disabled={busy}
                  onClick={() => { void actions.removeTemplateFormat(set.packId, format.documentType) }}
                >
                  ×
                </button>
              )}
            </span>
          )
        })}
      </div>
      {set.kind === 'custom' && (addingFormat
        ? (
          <AddFormatForm
            set={set}
            state={state}
            addTemplateFormat={actions.addTemplateFormat}
            close={() => { setAddingFormat(false) }}
            t={t}
          />
        )
        : (
          <Button
            variant="toolbar"
            size="sm"
            icon={<IconPlusOutline16 />}
            disabled={busy}
            onClick={() => { setAddingFormat(true) }}
          >
            {t('library.addFormat')}
          </Button>
        ))}
    </li>
  )
}

/** The library body: every set, the add-set form, and (in a project) the no-template choice. */
export function TemplateLibraryView({
  state, project, loadLibrary, createTemplateSet, deleteTemplateSet, addTemplateFormat, removeTemplateFormat, t,
}: TemplateLibraryViewProps): ReactNode {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  useEffect(() => {
    void loadLibrary()
  }, [loadLibrary])
  const busy = state.action !== null
  const actions = { loadLibrary, createTemplateSet, deleteTemplateSet, addTemplateFormat, removeTemplateFormat }
  const create = async (): Promise<void> => {
    const result = await createTemplateSet({ name })
    if (result.ok) {
      setCreating(false)
      setName('')
    }
  }

  return (
    <div className={css.view} data-paperai-library={project === undefined ? 'settings' : 'project'}>
      {state.library === null && state.phase !== 'error' && (
        <p className={css.message} aria-live="polite">{t('library.loading')}</p>
      )}
      {state.phase === 'error' && (
        <div className={css.failure} role="alert">
          <span>{t('library.error')}</span>
          <Button variant="toolbar" size="sm" icon={<IconRefreshOutline14 />} onClick={() => { void loadLibrary(true) }}>
            {t('library.retry')}
          </Button>
        </div>
      )}
      {state.library !== null && (
        <ul className={css.list}>
          {state.library.sets.map(set => (
            <SetCard key={set.packId} set={set} state={state} project={project} actions={actions} t={t} />
          ))}
          {project !== undefined && (
            <li className={clsx(css.noneRow, project.decided && project.packId === null && css.cardCurrent)}>
              {project.decided && project.packId === null
                ? (
                  <span className={css.currentTag}>
                    <IconCheckOutline14 />
                    <span>{t('library.noneCurrent')}</span>
                  </span>
                )
                : (
                  <Button
                    variant="toolbar"
                    size="sm"
                    disabled={busy || project.choosing}
                    onClick={() => { void project.choose(null) }}
                  >
                    {t('library.useNone')}
                  </Button>
                )}
            </li>
          )}
        </ul>
      )}
      {state.library !== null && (creating
        ? (
          <form
            className={css.createForm}
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <Input
              aria-label={t('library.name')}
              placeholder={t('library.namePlaceholder')}
              value={name}
              autoFocus
              disabled={busy}
              onChange={(event) => { setName(event.currentTarget.value) }}
            />
            <Button variant="outline" size="sm" type="submit" disabled={busy || name.trim().length === 0}>
              {t('library.create')}
            </Button>
            <Button variant="toolbar" size="sm" disabled={busy} onClick={() => { setCreating(false) }}>
              {t('library.cancel')}
            </Button>
          </form>
        )
        : (
          <Button
            variant="outline"
            size="sm"
            icon={<IconPlusOutline16 />}
            disabled={busy}
            onClick={() => { setCreating(true) }}
          >
            {t('library.add')}
          </Button>
        ))}
      {state.actionError !== null && <p className={css.error} role="alert">{t('library.failed')}</p>}
    </div>
  )
}

/** The project's template choice as a dialog over the current screen. */
export function TemplateDialog({ open, onClose, ...view }: TemplateLibraryViewProps & {
  open: boolean
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={view.t('library.dialogTitle')}
      description={view.t('library.dialogIntro')}
      closeLabel={view.t('library.close')}
      className={css.dialog ?? ''}
      contentClassName={css.dialogContent ?? ''}
    >
      <TemplateLibraryView {...view} />
    </Modal>
  )
}

/** The Templates settings page: the same library without a project to decide for. */
export function TemplatesSection({
  useLibrary, loadLibrary, createTemplateSet, deleteTemplateSet, addTemplateFormat, removeTemplateFormat, t,
}: PaperAITemplatesSectionProps): ReactNode {
  const state = useLibrary(value => value)
  return (
    <section className={css.settings} aria-labelledby="paperai-templates-heading">
      <h2 className={css.settingsTitle} id="paperai-templates-heading">{t('library.title')}</h2>
      <p className={css.settingsIntro}>{t('library.intro')}</p>
      <TemplateLibraryView
        state={state}
        loadLibrary={loadLibrary}
        createTemplateSet={createTemplateSet}
        deleteTemplateSet={deleteTemplateSet}
        addTemplateFormat={addTemplateFormat}
        removeTemplateFormat={removeTemplateFormat}
        t={t}
      />
    </section>
  )
}
