import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createWakeBudget,
  WATCH_DEFAULTS,
  watchFrameBudget,
  watchSilentFloorSec,
} from '../src/watch-loop.js'

test('watchFrameBudget 按时长估最多帧数', () => {
  assert.equal(watchFrameBudget(30), 4)
  assert.equal(watchFrameBudget(60), 8)
  assert.equal(watchFrameBudget(10), 2)
})

test('watchSilentFloorSec 短盯更密', () => {
  assert.equal(watchSilentFloorSec(30), 10)
  assert.equal(watchSilentFloorSec(60), 20)
  assert.ok(watchSilentFloorSec(15) >= 8)
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
