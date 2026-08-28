import { describe, expect, it } from 'vitest'
import { parseBodyInspection } from '../src/inspection.ts'

describe('parseBodyInspection', () => {
  it('returns no nodes for absent or malformed body results', () => {
    expect(parseBodyInspection({})).toEqual([])
    expect(parseBodyInspection({ results: 'invalid' })).toEqual([])
    expect(parseBodyInspection({ results: [] })).toEqual([])
  })

  it('uses the first result as a fallback and filters malformed children and raw XML', () => {
    expect(parseBodyInspection({
      results: [{
        type: 'unexpected',
        children: [
          null,
          'invalid',
          { path: 12 },
          {
            path: '/body/p[1]',
            type: 'paragraph',
            text: 42,
            format: 'invalid',
          },
          {
            path: '/body/p[2]',
            type: 'paragraph',
            text: '正文',
            style: 'Normal',
            format: { size: '12pt', xml: '<w:rPr/>', 'markRPr.xml': '<w:rPr/>' },
          },
        ],
      }],
    })).toEqual([
      { path: '/body/p[1]', type: 'paragraph', text: '', format: {} },
      { path: '/body/p[2]', type: 'paragraph', text: '正文', styleName: 'Normal', format: { size: '12pt' } },
    ])
  })

  it('selects the explicit body result when other results precede it', () => {
    expect(parseBodyInspection({
      results: [
        { type: 'metadata', children: [{ path: '/ignored' }] },
        { type: 'body', children: [{ path: '/body/p[1]', type: 'paragraph', text: '保留', format: {} }] },
      ],
    })).toEqual([{ path: '/body/p[1]', type: 'paragraph', text: '保留', format: {} }])
  })
})
