import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareFingerprints,
  hashPayload,
  shouldVerifyAction,
} from '../src/verify-act.js'

test('shouldVerifyAction 只覆盖有副作用动作', () => {
  assert.equal(shouldVerifyAction('click'), true)
  assert.equal(shouldVerifyAction('move'), false)
  assert.equal(shouldVerifyAction('screen'), false)
})

test('指纹相同 → maybeNoop', () => {
  const h = hashPayload('abc')
  assert.ok(h.startsWith('sha256:'))
  const cmp = compareFingerprints(h, h)
  assert.equal(cmp.maybeNoop, true)
  assert.equal(compareFingerprints(h, hashPayload('xyz')).maybeNoop, false)
})
