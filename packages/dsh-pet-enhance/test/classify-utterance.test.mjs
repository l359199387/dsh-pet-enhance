import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildClassifyPrompt,
  CLASSIFY_PREFIX,
  classifyUtterance,
  isSkillStatusQuestion,
  localClassify,
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

test('localClassify：「学会了吗」是 chat，不是 task', () => {
  assert.equal(localClassify('你学会记录心情了吗?'), 'chat')
  assert.equal(localClassify('会不会保存文件'), 'chat')
  assert.equal(isSkillStatusQuestion('你学会记录心情了吗?'), true)
  assert.equal(localClassify('今天天气真好'), 'chat')
  assert.equal(localClassify('看一眼桌面'), 'glance')
  assert.equal(localClassify('我教你一下保存'), 'teach')
  assert.equal(localClassify('教完了'), 'teach_end')
  assert.equal(localClassify('把窗口最小化'), 'task')
  assert.equal(localClassify('执行一下记录每日心情'), 'task')
  assert.equal(localClassify('去记录一下每日心情'), 'task')
  assert.equal(localClassify('去看看B站'), 'task')
  assert.equal(localClassify('继续去看看B站'), 'task')
  assert.equal(localClassify('再做一次'), 'task')
  assert.equal(regexClassifyFallback('教完了', { teaching: true }), 'teach_end')
})

test('classifyUtterance：默认不 wake，走 local（即使用 ctx）', async () => {
  let woke = 0
  const r = await classifyUtterance({ fake: true }, '你学会记录心情了吗?', {
    wake: async () => {
      woke += 1
      return { ok: true, sessionId: 's' }
    },
    waitReply: async () => ({ ok: true, text: 'task' }),
  })
  assert.equal(r.label, 'chat')
  assert.equal(r.via, 'local')
  assert.equal(woke, 0)
})

test('classifyUtterance：inject 路径优先', async () => {
  const r = await classifyUtterance({}, '你好呀', {
    complete: async () => 'chat',
  })
  assert.equal(r.label, 'chat')
  assert.equal(r.via, 'inject')
})
