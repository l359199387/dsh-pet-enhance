import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSmartRunPrompt,
  buildTeachFollowupQuestions,
  buildTeachSmartDigestPrompt,
  mergeTeachQuestions,
  parseTeachSmartReply,
} from '../src/teach-smart.js'
import { createGlanceState } from '../src/state.js'
import { parseTeachDigestReply } from '../src/teach-bridge.js'

test('parseTeachSmartReply：OK + FAST', () => {
  const r = parseTeachSmartReply('OK: 每天记心情\nFAST: 写文件到「每日心情/日期.txt」')
  assert.equal(r.ok, true)
  assert.match(r.summary, /心情/)
  assert.match(r.fastPlan, /写文件/)
})

test('parseTeachDigestReply 兼容 FAST', () => {
  const r = parseTeachDigestReply('OK: 打开B站\nFAST: 浏览器打开 https://www.bilibili.com')
  assert.equal(r.ok, true)
  assert.match(r.fastPlan, /bilibili/)
})

test('教完必问至少 3 条', () => {
  const qs = buildTeachFollowupQuestions('记录每日心情', [{ action: 'click' }], {
    fastPlan: '写文件',
  })
  assert.ok(qs.length >= 3)
  assert.ok(qs.some((q) => q.code === 'purpose'))
  assert.ok(qs.some((q) => q.code === 'fast-ok'))
  assert.ok(qs.some((q) => q.code === 'adapt'))
})

test('mergeTeachQuestions 去重且保留必问', () => {
  const m = mergeTeachQuestions(
    [{ code: 'purpose', summary: '旧' }, { code: 'window', summary: '窗' }],
    buildTeachFollowupQuestions('g', [{ action: 'type' }]),
  )
  assert.equal(m.filter((q) => q.code === 'purpose').length, 1)
  assert.ok(m.some((q) => q.code === 'window'))
})

test('buildSmartRunPrompt 含快捷路径', () => {
  const p = buildSmartRunPrompt({
    id: 'x',
    goal: '进B站',
    strategy: { fastPlan: '打开 https://www.bilibili.com', summary: '打开B站' },
  })
  assert.match(p, /bilibili/)
  assert.match(p, /不要机械复刻/)
  assert.match(p, /动手纪律·C3/)
})

test('glance state：teachEndOffer', () => {
  const s = createGlanceState()
  assert.equal(s.snapshot().guard.teachEndOffer.data, false)
  s.setTeachEndOffer(true)
  assert.equal(s.snapshot().guard.teachEndOffer.data, true)
  s.panic()
  assert.equal(s.snapshot().guard.teachEndOffer.data, false)
})

test('smart digest prompt 要求变通', () => {
  const p = buildTeachSmartDigestPrompt('进B站', '1. 点击')
  assert.match(p, /FAST/)
  assert.match(p, /变通|最快/)
})

test('smart digest prompt：拼图时写 1 张与格数', () => {
  const p = buildTeachSmartDigestPrompt('进B站', '1. 点击', [{
    mosaic: true,
    sourceCount: 4,
    cells: [{}, {}, {}, {}],
  }])
  assert.match(p, /1 张拼图/)
  assert.match(p, /4 格/)
  assert.match(p, /222/)
})
