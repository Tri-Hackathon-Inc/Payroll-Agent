import test from 'node:test'
import assert from 'node:assert/strict'
import { paycheckExplanation, money } from '../src/paycheckPresentation.js'

test('uses exact net difference and does not invent overtime cause', () => {
  const result = paycheckExplanation({ previous: {}, currency: 'USD', netChange: -283.78, reconciled: true,
    rows: [{ label: 'Gross pay', kind: 'earning', delta: -416.46 }, { label: 'Federal tax', kind: 'withholding', delta: -68.83 }] })
  assert.equal(result.title, 'Take-home pay is $283.78 lower')
  assert.match(result.detail, /Gross pay decreased by \$416.46/)
  assert.doesNotMatch(result.detail, /overtime/)
})
test('missing history and amounts remain explicit', () => {
  assert.equal(money(null), 'Not available')
  assert.match(paycheckExplanation({ previous: null }).title, /No comparable/)
  assert.match(paycheckExplanation({ previous: {}, netChange: null }).title, /incomplete/)
})
test('unreconciled records cannot claim a complete explanation', () => {
  assert.match(paycheckExplanation({ previous: {}, netChange: 0, rows: [], reconciled: false }).note, /do not fully reconcile/)
})
