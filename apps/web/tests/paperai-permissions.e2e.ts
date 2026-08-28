import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const PAPERAI_OVERLAY = fileURLToPath(new URL(
  '../../../packages/bundle/paperai-web/cordis.patch.yml',
  import.meta.url,
))

describe('PaperAI permission composition', { concurrent: false }, () => {
  let scaffold: WebScaffold
  let originalPermissionMode: string | undefined

  beforeAll(async () => {
    originalPermissionMode = process.env.DSH_PERMISSION_MODE
    Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    scaffold = await launchWebScaffold({ extraOverlayPath: PAPERAI_OVERLAY })
  }, 60_000)

  afterAll(async () => {
    await scaffold?.close()
    if (originalPermissionMode === undefined) {
      Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    } else {
      process.env.DSH_PERMISSION_MODE = originalPermissionMode
    }
  })

  it('seeds a fresh session with the inherited confined-access preset', () => {
    const session = scaffold.ctx.sessions.create(SessionId('paperai-safe-default'))

    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'workspace-write' }],
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ])
  })
})
