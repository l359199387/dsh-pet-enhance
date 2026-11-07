import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGlanceState, normalizePetState } from '../src/state.js'

test('normalizePetState 只认七态', () => {
  assert.equal(normalizePetState('Acting'), 'acting')
  assert.equal(normalizePetState('nope'), 'idle')
})

test('panic 进入 alarmed 并解除 armed', () => {
  const s = createGlanceState()
  const before = s.counter
  s.panic()
  const snap = s.snapshot()
  assert.ok(s.counter > before)
  assert.equal(snap.pet.state.data, 'alarmed')
  assert.equal(snap.guard.armed.data, false)
  assert.equal(snap.guard.panicHold.data, true)
})

test('急停保持期内回 idle 不重新武装', () => {
  const s = createGlanceState()
  s.panic()
  s.setPet('idle')
  assert.equal(s.snapshot().pet.state.data, 'idle')
  assert.equal(s.snapshot().guard.armed.data, false)
  assert.equal(s.isPanicking(), true)
  s.clearPanicHold()
  assert.equal(s.snapshot().guard.armed.data, true)
  assert.equal(s.isPanicking(), false)
})

test('setWindow 同值不 bump counter', () => {
  const s = createGlanceState()
  s.setWindow({ title: 'Edge', hwnd: 1 })
  const c = s.counter
  s.setWindow({ title: 'Edge', hwnd: 1 })
  assert.equal(s.counter, c)
  s.setWindow({ title: 'Code', hwnd: 2 })
  assert.ok(s.counter > c)
})
