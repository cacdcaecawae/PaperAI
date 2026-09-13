import { describe, expect, it } from 'vitest'
import { typeAccent } from '../src/client/type-accent.ts'

describe('typeAccent', () => {
  it('hands a typed row its brand tokens and leaves an untyped row on the neutral labels', () => {
    expect(typeAccent('midterm')).toEqual({
      '--paperai-row-accent': 'var(--paperai-type-midterm)',
      '--paperai-row-tint': 'var(--paperai-type-midterm-tint)',
    })
    expect(typeAccent('other')).toBeUndefined()
  })
})
