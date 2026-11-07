import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFrameSelector, REF_SCORE } from '../src/select-frames.js'

test('首帧必留', () => {
  const sel = createFrameSelector({ silentFloorSec: 20 })
  sel.reset(0)
  const r = sel.push({ score: null, t: 0, isFirst: true })
  assert.equal(r.keep, true)
  assert.equal(r.reason, 'first')
})

test('硬切：高分且过最小间隔', () => {
  const sel = createFrameSelector({ cutAbs: 12, markMinGap: 0.5 })
  sel.reset(0)
  sel.push({ score: null, t: 0, isFirst: true })
  assert.equal(sel.push({ score: 3, t: 0.4 }).keep, false)
  const cut = sel.push({ score: 20, t: 1.0 })
  assert.equal(cut.keep, true)
  assert.equal(cut.reason, 'cut')
})

test('积分：中等运动攒够才留', () => {
  const sel = createFrameSelector({
    cutAbs: 100,
    integralSeconds: 3,
    fps: 1,
    markMinGap: 0.5,
    silentFloorSec: 999,
  })
  sel.reset(0)
  sel.push({ score: null, t: 0, isFirst: true })
  // need = REF_SCORE * 1 * 3 = 12
  assert.equal(REF_SCORE * 1 * 3, 12)
  assert.equal(sel.push({ score: 4, t: 1 }).keep, false)
  assert.equal(sel.push({ score: 4, t: 2 }).keep, false)
  const hit = sel.push({ score: 4, t: 3 })
  assert.equal(hit.keep, true)
  assert.equal(hit.reason, 'integral')
})

test('静止兜底：silentFloorSec 后留一帧', () => {
  const sel = createFrameSelector({
    cutAbs: 100,
    integralSeconds: 999,
    silentFloorSec: 20,
    markMinGap: 0.5,
  })
  sel.reset(0)
  sel.push({ score: null, t: 0, isFirst: true })
  assert.equal(sel.push({ score: 0.1, t: 10 }).keep, false)
  const floor = sel.push({ score: 0.1, t: 20.1 })
  assert.equal(floor.keep, true)
  assert.equal(floor.reason, 'floor')
})
