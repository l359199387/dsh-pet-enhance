import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CANVAS_BY_QUALITY,
  IMAGE_CELL,
  alignDownToCell,
  imageTokens,
} from '../src/image-tokens.js'

test('画布宽高均为 42 倍数', () => {
  for (const [q, c] of Object.entries(CANVAS_BY_QUALITY)) {
    assert.equal(c.w % IMAGE_CELL, 0, `${q} w`)
    assert.equal(c.h % IMAGE_CELL, 0, `${q} h`)
  }
})

test('文档表：low/standard/high token 锁定', () => {
  assert.equal(imageTokens(798, 462), 222)
  assert.equal(imageTokens(1050, 630), 392)
  assert.equal(imageTokens(1260, 756), 560)
  assert.equal(CANVAS_BY_QUALITY.low.tokens, 222)
  assert.equal(CANVAS_BY_QUALITY.standard.tokens, 392)
  assert.equal(CANVAS_BY_QUALITY.high.tokens, 560)
})

test('800×450 比 798×462 更贵（阶梯）', () => {
  assert.ok(imageTokens(800, 450) > imageTokens(798, 462))
})

test('alignDownToCell', () => {
  assert.equal(alignDownToCell(800), 798)
  assert.equal(alignDownToCell(42), 42)
  assert.equal(alignDownToCell(41), 0)
})
