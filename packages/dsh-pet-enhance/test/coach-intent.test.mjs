import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCoachClassifyPrompt,
  classifyCoachUtterance,
  COACH_CLASSIFY_PREFIX,
  parseCoachClassifyLabel,
} from '../src/coach-intent.js'

test('buildCoachClassifyPrompt：要求模型判标签且不写死口令', () => {
  const p = buildCoachClassifyPrompt('弄好了帮我记一下', { goal: '写桌面笔记' })
  assert.ok(p.startsWith(COACH_CLASSIFY_PREFIX))
  assert.match(p, /done=/)
  assert.match(p, /abort=/)
  assert.match(p, /correct=/)
  assert.match(p, /guide=/)
  assert.match(p, /不要死抠固定口令/)
  assert.match(p, /写桌面笔记/)
  assert.match(p, /弄好了帮我记一下/)
})

test('parseCoachClassifyLabel：解析模型输出标签', () => {
  assert.equal(parseCoachClassifyLabel('done'), 'done')
  assert.equal(parseCoachClassifyLabel('标签：abort'), 'abort')
  assert.equal(parseCoachClassifyLabel('correct\n顺便说一句'), 'correct')
  assert.equal(parseCoachClassifyLabel('guide'), 'guide')
  assert.equal(parseCoachClassifyLabel(''), null)
  assert.equal(parseCoachClassifyLabel('乱七八糟'), null)
})

test('classifyCoachUtterance：走模型，空句 guide；失败回落 guide', async () => {
  assert.equal(await classifyCoachUtterance({}, ''), 'guide')

  const label = await classifyCoachUtterance({}, '随便说说', {
    wake: async () => ({ ok: false, reason: 'no-session' }),
    log: () => {},
  })
  assert.equal(label, 'guide')

  const done = await classifyCoachUtterance({}, '这回可以收工了', {
    wake: async () => ({ ok: true, sessionId: 's1' }),
    waitReply: async () => ({ ok: true, text: 'done' }),
    log: () => {},
  })
  assert.equal(done, 'done')

  const correct = await classifyCoachUtterance({}, '刚才那个步骤换一种', {
    wake: async () => ({ ok: true, sessionId: 's1' }),
    waitReply: async () => ({ ok: true, text: 'correct' }),
    log: () => {},
  })
  assert.equal(correct, 'correct')
})
