import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createWakeBudget,
  decideSheetFlush,
  SHEET_DEFAULTS,
  WATCH_DEFAULTS,
} from '../src/watch-loop.js'

test('decideSheetFlush：prefer=2 即封', () => {
  assert.equal(decideSheetFlush({ length: 2, sheetAgeSec: 0.1 }), 'prefer')
  assert.equal(decideSheetFlush({ length: 1, sheetAgeSec: 1 }), null)
})

test('decideSheetFlush：cap=4', () => {
  assert.equal(decideSheetFlush({ length: 4, sheetAgeSec: 0 }), 'cap')
})

test('decideSheetFlush：单帧等满 min(30, 2×maxWait)', () => {
  assert.equal(decideSheetFlush({
    length: 1,
    sheetAgeSec: Math.min(30, SHEET_DEFAULTS.maxWaitSec * 2),
  }), 'time')
  assert.equal(decideSheetFlush({
    length: 1,
    sheetAgeSec: SHEET_DEFAULTS.maxWaitSec,
  }), null)
  // maxWait 很大时仍封顶 30s（see-now region）
  assert.equal(decideSheetFlush({
    length: 1,
    sheetAgeSec: 30,
    maxWaitSec: 60,
  }), 'time')
  assert.equal(decideSheetFlush({
    length: 1,
    sheetAgeSec: 29,
    maxWaitSec: 60,
  }), null)
})

test('SHEET_DEFAULTS 对齐 see-now region', () => {
  assert.equal(SHEET_DEFAULTS.preferFrames, 2)
  assert.equal(SHEET_DEFAULTS.maxFramesPerSheet, 4)
  assert.equal(SHEET_DEFAULTS.maxWaitSec, 15)
  assert.equal(SHEET_DEFAULTS.silentFloorSec, 20)
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
