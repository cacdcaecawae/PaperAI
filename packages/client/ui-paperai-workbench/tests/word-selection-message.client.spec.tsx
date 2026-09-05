// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { WordSelectionMessage } from '../src/client/WordSelectionMessage.tsx'
import { wordSelectionReference } from '../src/client/selection-context.ts'
import { documentSnapshot, NODE_PARAGRAPH } from './fixtures.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function show(matched: string) {
  const props: ComponentProps<typeof WordSelectionMessage> = {
    matched, text: matched, t: key => (zh as Record<string, string>)[key] ?? key,
  } as ComponentProps<typeof WordSelectionMessage>
  return render(<WordSelectionMessage {...props} />)
}

describe('logged Word quotations', () => {
  it('shows exact quotations and surrounding requests while folding source identifiers', () => {
    const reference = wordSelectionReference(documentSnapshot(), { nodeIds: [NODE_PARAGRAPH], text: 'A <quote>\n中文' })
    const { container } = show(`Please revise\n${reference.ref}\nKeep its meaning.`)
    expect(container.querySelector('blockquote')?.textContent).toBe('A <quote>\n中文')
    expect(container.textContent).toContain('Please revise')
    expect(container.textContent).toContain('Keep its meaning.')
    expect(screen.getByText('查看引用来源')).toBeTruthy()
    const disclosure = container.querySelector('details')!
    expect(disclosure.open).toBe(false)
    expect(disclosure.textContent).toContain(NODE_PARAGRAPH)
    expect(container.querySelector('quote')).toBeNull()
  })

  it.each([
    'not JSON', 'null', '42', '{"text":"unrecognized"}',
    '{"document":"d","path":"p","version":"v","revision":"r","blocks":[5],"text":"unknown block"}',
    '{"document":"d","path":"p","version":"v","revision":"r","blocks":[],"text":"x","extra":"keep this visible"}',
  ])('preserves unrecognized context verbatim: %s', (payload) => {
    const text = `[Word selection]\n${payload}\n[/Word selection]`
    const { container } = show(text)
    expect(container.textContent).toBe(text)
    expect(container.querySelector('details')).toBeNull()
  })

  it('renders multiple selections including an uncommitted document', () => {
    const document = documentSnapshot()
    const first = wordSelectionReference({ ...document, headCommitId: null }, { nodeIds: [], text: 'first' })
    const second = wordSelectionReference(document, { nodeIds: [NODE_PARAGRAPH], text: 'second' })
    const { container } = show(first.ref + second.ref)
    expect([...container.querySelectorAll('blockquote')].map(block => block.textContent)).toEqual(['first', 'second'])
  })
})
