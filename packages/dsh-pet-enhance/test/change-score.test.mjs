import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createHostScorer,
  rgbToHsv,
  scoreHsvPair,
  solidGridRgb,
} from '../src/change-score.js'

test('相同画面变化分为 0', () => {
  const a = rgbToHsv(solidGridRgb(40, 80, 120))
  assert.equal(scoreHsvPair(a, a), 0)
})

test('色相大变 → 明显高分', () => {
  const red = rgbToHsv(solidGridRgb(220, 30, 30))
  const blue = rgbToHsv(solidGridRgb(30, 30, 220))
  const score = scoreHsvPair(red, blue)
  assert.ok(score > 20, `期望 >20，实际 ${score}`)
})

test('流式 scorer：首帧 null，第二帧有分', () => {
  const scorer = createHostScorer()
  assert.equal(scorer.pushRgb(solidGridRgb(10, 10, 10)), null)
  const s = scorer.pushRgb(solidGridRgb(200, 200, 200))
  assert.equal(typeof s, 'number')
  assert.ok(s > 5)
})
