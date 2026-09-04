import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const workbench = read('../src/client/DocumentWorkbench.module.css')
const sidebar = read('../src/client/WorkspaceContent.module.css')
const start = read('../src/client/StartPage.module.css')
const library = read('../src/client/TemplateLibrary.module.css')
const preview = read('../src/client/DocumentPreview.tsx')
const components = [
  read('../src/client/DocumentWorkbench.tsx'), read('../src/client/panels.tsx'),
  read('../src/client/StartPage.tsx'), read('../src/client/TemplateLibrary.tsx'),
  read('../src/client/WorkspaceContent.tsx'),
].join('\n')

describe('PaperAI DSH-native styling', () => {
  it('keeps the document view inside the ui-layout width and adapts through a container query', () => {
    expect(workbench).toContain('container-type: inline-size')
    expect(workbench).toContain('@container paperai-workbench (max-width: 520px)')
    expect(workbench).not.toMatch(/\.root\s*\{[^}]*\bwidth:\s*\d+px/s)
    expect(workbench).not.toContain('100vw')
  })

  it('follows the sidebar row and heading metrics of the DSH session list', () => {
    expect(sidebar).toContain('height: 32px')
    expect(sidebar).toContain('border-radius: 8px')
    expect(sidebar).toContain('font-size: 14px')
    expect(sidebar).toContain('min-height: 34px')
    expect(sidebar).toContain('var(--dsw-alias-interactive-bg-hover)')
    expect(start).toContain('grid-template-columns: 34px auto')
    expect(start).toContain('font-size: 26px')
  })

  it('paints only through theme tokens, with no drop shadows, literal colors, or product accent overrides', () => {
    for (const sheet of [workbench, sidebar, start, library]) {
      // Focus rings (0 0 0 2px) are fine; offset or blurred drop shadows are not DSH vocabulary.
      expect(sheet).not.toMatch(/box-shadow:\s*(?:0|-?\d+px)\s+-?\d+px\s+\d+px/u)
      expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b/iu)
      expect(sheet).not.toMatch(/\brgb\(/u)
    }
    expect(workbench).toContain('var(--dsw-alias-border-l2)')
    expect(library).toContain('var(--dsw-alias-border-l2)')
  })

  it('keeps the Host preview inert: no scripts, no inline handlers, no editable HTML', () => {
    expect(preview).toContain('DOMParser')
    expect(preview).toContain("attachShadow({ mode: 'open' })")
    expect(preview).toMatch(/script, iframe, object, embed/u)
    expect(preview).toContain("name.startsWith('on')")
    expect(preview).not.toContain('dangerouslySetInnerHTML')
    expect(preview).not.toContain('contentEditable')
    expect(preview).toContain('<textarea')
  })

  it('composes from DSH primitives and never reaches for a primary button or card vocabulary', () => {
    expect(components).not.toContain('variant="primary"')
    expect(components).not.toMatch(/className=\{css\.card\b/u)
    expect(components).toContain('variant="toolbar"')
    expect(components).toContain('variant="outline"')
    expect(components).toContain('DetailsViewShell')
    expect(components).toContain('<Modal')
  })
})
