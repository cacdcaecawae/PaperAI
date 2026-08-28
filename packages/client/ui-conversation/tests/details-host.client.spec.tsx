// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT,
  type SessionListState, type WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RenderOpts } from '@deepseek-ai/dsh-client-ui-slots'
import type { DetailsViewOwnerProps } from '../src/client/contract/slots.ts'
import type { ChatStoreState } from '../src/client/contract/views.ts'
import { DetailsViewHost } from '../src/client/skeleton/DetailsViewHost.tsx'
import type { DetailsViewHostProps } from '../src/client/skeleton/DetailsViewHost.tsx'

afterEach(cleanup)

const labels: Readonly<Record<string, string>> = {
  'details.close': 'Close details',
  'details.unavailableTitle': 'Details view unavailable',
  'details.unavailable': 'The selected details plugin is unavailable.',
  'details.empty': 'Choose a tool call',
  'details.title': 'Details',
}

function props(active: string, renderSlot: DetailsViewHostProps['renderSlot'], closeDetails = vi.fn()): DetailsViewHostProps {
  const chat = createSnapshotStore<ChatStoreState>({ selection: null, draft: '', view: null, inspect: null })
  const sessions = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspaces = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  const useDetailsView: DetailsViewHostProps['useDetailsView'] = selector => selector(active)
  const t: DetailsViewHostProps['t'] = key => labels[key] ?? key
  return {
    useDetailsView,
    renderSlot,
    closeDetails,
    t,
    useStore: bindSnapshotSelector(chat),
    useSession: bindSnapshotSelector(createSnapshotStore(EMPTY_CHAT_SNAPSHOT)),
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useProjection: () => undefined,
    sessionId: 'session',
    actions: {},
  } as unknown as DetailsViewHostProps
}

type DetailsViewRender = (
  name: 'conversation.details.view',
  owner: DetailsViewOwnerProps,
  options?: RenderOpts,
) => ReactNode

describe('DetailsViewHost', () => {
  it('dispatches an additive full-column view by its id and owner close operation', () => {
    const closeDetails = vi.fn()
    const renderView = vi.fn<DetailsViewRender>((_name, owner, options) => (
      <button type="button" onClick={owner.closeDetails}>{options?.only}</button>
    ))
    const renderSlot = renderView as unknown as DetailsViewHostProps['renderSlot']
    render(<DetailsViewHost {...props('paperai', renderSlot, closeDetails)} />)
    expect(screen.getByRole('button', { name: 'paperai' })).toBeTruthy()
    expect(renderView).toHaveBeenCalledWith(
      'conversation.details.view',
      { closeDetails },
      expect.objectContaining({ only: 'paperai' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'paperai' }))
    expect(closeDetails).toHaveBeenCalledTimes(1)
  })

  it('keeps the built-in Tool details panel as the default view', () => {
    const renderSlot = vi.fn(() => null) as unknown as DetailsViewHostProps['renderSlot']
    render(<DetailsViewHost {...props('tool', renderSlot)} />)
    expect(screen.getByText('Choose a tool call')).toBeTruthy()
    expect(renderSlot).not.toHaveBeenCalledWith('conversation.details.view', expect.anything(), expect.anything())
  })

  it('shows an actionable fallback if a selected entry disappears before reconciliation', () => {
    const closeDetails = vi.fn()
    const renderView = vi.fn<DetailsViewRender>((_name, _owner, options) => options?.fallback)
    const renderSlot = renderView as unknown as DetailsViewHostProps['renderSlot']
    render(<DetailsViewHost {...props('missing', renderSlot, closeDetails)} />)
    expect(screen.getByText('Details view unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(closeDetails).toHaveBeenCalledTimes(1)
  })
})
