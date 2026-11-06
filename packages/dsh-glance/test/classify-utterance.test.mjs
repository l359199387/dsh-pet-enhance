import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildClassifyPrompt,
  CLASSIFY_PREFIX,
  classifyUtterance,
  parseClassifyLabel,
  regexClassifyFallback,
} from '../src/classify-utterance.js'

test('buildClassifyPrompt：极短、带分流前缀、禁工具', () => {
  const p = buildClassifyPrompt('帮我把记事本最小化')
  assert.ok(p.startsWith(CLASSIFY_PREFIX))
  assert.ok(p.includes('禁止工具'))
  assert.ok(p.includes('帮我把记事本最小化'))
  assert.ok(p.length < 280)
})

test('parseClassifyLabel：抽标签', () => {
  assert.equal(parseClassifyLabel('task'), 'task')
  assert.equal(parseClassifyLabel('标签：chat'), 'chat')
  assert.equal(parseClassifyLabel('teach_end\n'), 'teach_end')
  assert.equal(parseClassifyLabel(''), null)
})

test('regexClassifyFallback：兜底粗筛', () => {
  assert.equal(regexClassifyFallback('今天天气真好'), 'chat')
  assert.equal(regexClassifyFallback('看一眼桌面'), 'glance')
  assert.equal(regexClassifyFallback('我教你一下保存'), 'teach')
  assert.equal(regexClassifyFallback('教完了'), 'teach_end')
  assert.equal(regexClassifyFallback('把窗口最小化'), 'task')
  assert.equal(regexClassifyFallback('随便说说', { teaching: true }), 'chat')
  assert.equal(regexClassifyFallback('教完了', { teaching: true }), 'teach_end')
})

test('classifyUtterance：inject 路径优先', async () => {
  const r = await classifyUtterance({}, '你好呀', {
    complete: async () => 'chat',
  })
  assert.equal(r.label, 'chat')
  assert.equal(r.via, 'inject')
})

test('classifyUtterance：无模型回落 regex', async () => {
  const prev = process.env.DSH_GLANCE_CLASSIFY
  process.env.DSH_GLANCE_CLASSIFY = '0'
  try {
    const r = await classifyUtterance(null, '看一眼我的屏幕')
    assert.equal(r.label, 'glance')
    assert.equal(r.via, 'regex')
  } finally {
    if (prev === undefined) delete process.env.DSH_GLANCE_CLASSIFY
    else process.env.DSH_GLANCE_CLASSIFY = prev
  }
})
