/**
 * Forced-colors focus contract, asserted against base.css on disk: Windows high
 * contrast drops box-shadow, which is where controls draw their focus ring over
 * `outline: none`, so the global sheet puts a system-color outline back.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('puts a system-color focus outline back under forced colors', () => {
  const base = readFileSync(fileURLToPath(new URL('../src/styles/base.css', import.meta.url)), 'utf8')
  expect(base).toMatch(/@media \(forced-colors: active\) \{\s*:focus-visible \{\s*outline: 2px solid Highlight !important;/u)
})
