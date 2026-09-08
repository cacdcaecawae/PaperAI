import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { elicitForm } from '../src/elicitation.ts'

describe('ACP elicitation through user questions', () => {
  const request: CreateElicitationRequest = {
    mode: 'form', sessionId: 'session', message: 'Configure this run',
    requestedSchema: { type: 'object', required: ['style', 'count', 'enabled', 'sections'], properties: {
      style: { type: 'string', oneOf: [{ const: 'short', title: '简洁' }, { const: 'long', title: '详细' }] },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      enabled: { type: 'boolean' },
      sections: { type: 'array', minItems: 1, items: { type: 'string', enum: ['A', 'B'] } },
    } },
  }

  it('returns typed enum, integer, boolean, and multiple-choice values', async () => {
    const ask = vi.fn(async () => ({ answers: [
      { id: 'style', selected: ['简洁 (short)'] },
      { id: 'count', selected: [], custom: '3' },
      { id: 'enabled', selected: ['否'] },
      { id: 'sections', selected: ['A', 'B'] },
    ] }))
    expect(await elicitForm(request, ask, new AbortController().signal)).toEqual({
      action: 'accept', content: { style: 'short', count: 3, enabled: false, sections: ['A', 'B'] },
    })
    expect(ask.mock.calls).toHaveLength(1)
  })

  it('keeps a form open after invalid input instead of returning an invalid provider answer', async () => {
    const ask = vi.fn<Parameters<typeof elicitForm>[1]>()
      .mockResolvedValueOnce({ answers: [{ id: 'count', selected: [], custom: '12' }] })
      .mockResolvedValueOnce({ answers: [] })
    expect(await elicitForm(request, ask, new AbortController().signal)).toEqual({ action: 'decline' })
    expect(ask.mock.calls[1]?.[0].find(question => question.id === 'count')?.detail).toContain('count')
  })

  it('settles an interrupted form as cancellation', async () => {
    const abort = new AbortController()
    const ask = async () => { abort.abort(); throw new Error('cancelled') }
    expect(await elicitForm(request, ask, abort.signal)).toEqual({ action: 'cancel' })
  })

  it('does not advertise acceptance for a URL or unknown form field', async () => {
    const ask = vi.fn<Parameters<typeof elicitForm>[1]>()
    expect(await elicitForm({ mode: 'url', message: 'Login', sessionId: 's', elicitationId: 'e', url: 'https://example.com' }, ask, new AbortController().signal)).toEqual({ action: 'decline' })
    expect(await elicitForm({ mode: 'form', message: 'Custom', sessionId: 's', requestedSchema: { properties: { x: { type: '_vendor' } } } }, ask, new AbortController().signal)).toEqual({ action: 'decline' })
    expect(ask).not.toHaveBeenCalled()
  })
})
