import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chunkFrames,
  createWakeBudget,
  MOSAIC_FRAMES_PER_SHEET,
  WATCH_DEFAULTS,
  watchFrameBudget,
  watchSilentFloorSec,
} from '../src/watch-loop.js'

test('watchFrameBudget 按时长估最多帧数', () => {
  assert.equal(watchFrameBudget(30), 10)
  assert.equal(watchFrameBudget(60), 12)
  assert.equal(watchFrameBudget(10), 4)
  assert.equal(watchFrameBudget(20), 7)
})

test('chunkFrames 10 格拆成 3 张 2×2', () => {
  assert.equal(MOSAIC_FRAMES_PER_SHEET, 4)
  const chunks = chunkFrames(Array.from({ length: 10 }, (_, i) => i))
  assert.deepEqual(chunks.map((c) => c.length), [4, 4, 2])
})

test('watchSilentFloorSec 短盯更密', () => {
  assert.equal(watchSilentFloorSec(30), 8)
  assert.equal(watchSilentFloorSec(60), 15)
  assert.ok(watchSilentFloorSec(15) >= 6)
})

test('叫醒预算：第 9 次拒绝', () => {
  const b = createWakeBudget(8)
  for (let i = 0; i < 8; i += 1) {
    const r = b.beginWatch()
    assert.equal(r.ok, true, `第 ${i + 1} 次应放行`)
  }
  const denied = b.beginWatch()
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /8 次/)
  assert.equal(b.status().stopped, true)
})

test('用户发言清零', () => {
  const b = createWakeBudget(2)
  assert.equal(b.beginWatch().ok, true)
  assert.equal(b.beginWatch().ok, true)
  assert.equal(b.beginWatch().ok, false)
  b.noteUserTurn()
  assert.equal(b.beginWatch().ok, true)
  assert.equal(b.status().wakes, 1)
})

test('默认 maxAutonomousWakes=8', () => {
  assert.equal(WATCH_DEFAULTS.maxAutonomousWakes, 8)
})
