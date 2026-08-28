import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workbench = readFileSync(
  fileURLToPath(new URL('../src/client/DocumentWorkbench.module.css', import.meta.url)),
  'utf8',
)
const tree = readFileSync(
  fileURLToPath(new URL('../src/client/WorkspaceContent.module.css', import.meta.url)),
  'utf8',
)
const component = readFileSync(
  fileURLToPath(new URL('../src/client/DocumentWorkbench.tsx', import.meta.url)),
  'utf8',
)

describe('PaperAI DSH-native styling', () => {
  it('accepts the ui-layout width and adapts through a container query', () => {
    expect(workbench).toContain('container-type: inline-size')
    expect(workbench).toContain('@container paperai-workbench (max-width: 520px)')
    expect(workbench).toContain('grid-template-columns: minmax(156px, 34%) minmax(0, 1fr)')
    expect(workbench).toContain('grid-template-rows: minmax(116px, 36%) minmax(0, 1fr)')
    expect(workbench).not.toMatch(/\.root\s*\{[^}]*\bwidth:\s*\d+px/s)
    expect(workbench).not.toContain('100vw')
  })

  it('keeps complete HTML preview-only and edits one selected-node fragment', () => {
    expect(component).not.toContain('editorHtml')
    expect(component).not.toContain('outerHTML')
    expect(component).toContain('sandbox=""')
    expect(component).toContain('<textarea')
    expect(component).not.toContain('contentEditable')
    expect(component).not.toContain('allow-same-origin')
    expect(component).toContain('commitSelected')
  })

  it('uses normal text sizes, weak separators, and flat rows', () => {
    expect(workbench).toContain('font-size: 14px')
    expect(workbench).toContain('font-size: 13px')
    expect(workbench).toContain('var(--dsw-alias-border-l2)')
    expect(tree).toContain('min-height: 32px')
    expect(tree).toContain('var(--dsw-alias-interactive-bg-hover)')
    expect(workbench).not.toContain('box-shadow:')
    expect(tree).not.toContain('box-shadow:')
  })

  it('does not introduce full-width primary action buttons or card vocabulary', () => {
    expect(component).not.toContain('variant="primary"')
    expect(component).not.toMatch(/className=\{css\.card/)
    expect(component).toContain('variant="toolbar"')
    expect(component).toContain('variant="outline"')
  })
})
