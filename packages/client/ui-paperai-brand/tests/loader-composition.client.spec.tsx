// @vitest-environment jsdom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as brandApply, inject as brandInject } from '../src/client/index.ts'

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.brand.mark',
] as const

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  cleanup()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const BrandHoles = {
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
    } as never, () => null)
  },
}

const LocaleStub = {
  apply(ctx: Context): void {
    ctx.provide('locale', new LocaleRuntime(ctx))
  },
}

/** Boot a test-only client composition through the real Cordis Loader. */
async function loadComposition(): Promise<SlotRegistry> {
  root = await mkdtemp(join(tmpdir(), 'paperai-ui-brand-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'test-slot-registry'",
    "- name: 'test-locale'",
    "- name: 'test-brand-holes'",
    "- name: '@paperai/ui-brand'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-slot-registry', SlotRegistry],
    ['test-locale', LocaleStub],
    ['test-brand-holes', BrandHoles],
    ['@paperai/ui-brand', { inject: brandInject, apply: brandApply }],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()

  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return context.get('slots') as SlotRegistry
}

describe('PaperAI brand real Loader composition', () => {
  it('renders the user-visible wordmark and host-composed mark', async () => {
    const slots = await loadComposition()

    const Name = slots.entries('sidebar.brand.name')[0]?.component as ComponentType
    const name = render(<Name />)
    expect(name.container.querySelector('svg[data-brand-name="PaperAI"]')).not.toBeNull()
    cleanup()

    const Mark = slots.entries('conversation.hero.brand.mark')[0]?.component as ComponentType<{
      size: number
      className?: string
    }>
    const mark = render(<Mark size={34} className="hero-mark" />)
    const svg = mark.container.querySelector('svg')
    expect(svg?.getAttribute('height')).toBe('34')
    expect(svg?.getAttribute('class')?.split(' ')).toContain('hero-mark')
  })
})
