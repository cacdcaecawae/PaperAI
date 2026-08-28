import { describe, expect, it } from 'vitest'
import {
  deliveryBlocked,
  DocumentId,
  type GateReport,
} from '../src/index.ts'

const report = (mode: GateReport['mode'], severity: 'error' | 'warning', overridden = false): GateReport => ({
  status: severity === 'error' && !overridden ? 'fail' : 'pass-with-exceptions',
  mode,
  documentId: DocumentId('doc-1'),
  findings: [{
    id: 'finding-1',
    severity,
    code: 'fixture',
    message: 'fixture',
    overridden,
  }],
  checkedAt: '2026-08-28T00:00:00.000Z',
})

describe('PaperAI domain vocabulary', () => {
  it('brands ids without changing their wire value', () => {
    expect(DocumentId('doc-1')).toBe('doc-1')
  })

  it('blocks only active hard errors in delivery mode', () => {
    expect(deliveryBlocked(report('delivery-export', 'error'))).toBe(true)
    expect(deliveryBlocked(report('draft-export', 'error'))).toBe(false)
    expect(deliveryBlocked(report('delivery-export', 'warning'))).toBe(false)
    expect(deliveryBlocked(report('delivery-export', 'error', true))).toBe(false)
  })
})
