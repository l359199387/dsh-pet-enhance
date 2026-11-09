import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCoachClassifyPrompt,
  buildCoachGoalExtractPrompt,
  classifyCoachUtterance,
  COACH_CLASSIFY_PREFIX,
  extractCoachGoal,
  parseCoachClassifyLabel,
  parseCoachGoalReply,
} from '../src/coach-intent.js'

test('buildCoachClassifyPrompt：五类标签且要求语义理解', () => {
  const p = buildCoachClassifyPrompt('弄好了帮我记一下', { goal: '写桌面笔记' })
  assert.ok(p.startsWith(COACH_CLASSIFY_PREFIX))
  assert.match(p, /\bdone=/)
  assert.match(p, /\babort=/)
  assert.match(p, /\bcorrect=/)
  assert.match(p, /\bstep=/)
  assert.match(p, /\bopen=/)
  assert.match(p, /不要死抠固定口令/)
  assert.doesNotMatch(p, /guide=/)
})

test('parseCoachClassifyLabel：只解析模型英文标签', () => {
  assert.equal(parseCoachClassifyLabel('step'), 'step')
  assert.equal(parseCoachClassifyLabel('标签：open'), 'open')
  assert.equal(parseCoachClassifyLabel('done\n'), 'done')
  assert.equal(parseCoachClassifyLabel('guide'), 'open')
  assert.equal(parseCoachClassifyLabel('做成了'), null)
  assert.equal(parseCoachClassifyLabel(''), null)
})

test('parseCoachGoalReply / extractCoachGoal', async () => {
  assert.equal(parseCoachGoalReply('GOAL: 记录今天心情'), '记录今天心情')
  const goal = await extractCoachGoal({}, '现在我开始教你记录今天的心情', {
    wake: async () => ({ ok: true, sessionId: 's1' }),
    waitReply: async () => ({ ok: true, text: 'GOAL: 记录今天的心情' }),
    log: () => {},
  })
  assert.equal(goal, '记录今天的心情')
})

test('classifyCoachUtterance：走模型；失败有目标→step / 无目标→open', async () => {
  assert.equal(await classifyCoachUtterance({}, ''), 'open')
  assert.equal(await classifyCoachUtterance({}, 'x', {
    wake: async () => ({ ok: false, reason: 'no' }),
    log: () => {},
  }), 'open')
  assert.equal(await classifyCoachUtterance({}, '先打开记事本', {
    goal: '写笔记',
    wake: async () => ({ ok: false, reason: 'no' }),
    log: () => {},
  }), 'step')
  assert.equal(await classifyCoachUtterance({}, '先打开记事本', {
    wake: async () => ({ ok: true, sessionId: 's1' }),
    waitReply: async () => ({ ok: true, text: 'step' }),
    log: () => {},
  }), 'step')
})

test('buildCoachGoalExtractPrompt', () => {
  assert.match(buildCoachGoalExtractPrompt('我教你保存'), /GOAL:/)
})
