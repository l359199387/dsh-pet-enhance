import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildClassifyPrompt,
  CLASSIFY_PREFIX,
  classifyMode,
  classifyUtterance,
  formatLearnedGoalsForClassify,
  isLearnedGoalReplayIntent,
  isSkillStatusQuestion,
  localClassify,
  parseClassifyLabel,
  regexClassifyFallback,
  shouldEscalateChatToModel,
} from '../src/classify-utterance.js'
import { hasSkillReplaySoftCue } from '../src/intent.js'

test('buildClassifyPrompt：带分流前缀、禁工具、含已学会列表', () => {
  const p = buildClassifyPrompt('帮我把记事本最小化', {
    learnedGoals: ['记录每日心情', '看看B站'],
  })
  assert.ok(p.startsWith(CLASSIFY_PREFIX))
  assert.ok(p.includes('禁止'))
  assert.ok(p.includes('帮我把记事本最小化'))
  assert.match(p, /记录每日心情/)
  assert.match(p, /看看B站/)
  assert.match(p, /不必固定口令/)
})

test('formatLearnedGoalsForClassify', () => {
  assert.match(formatLearnedGoalsForClassify([]), /暂无/)
  assert.match(formatLearnedGoalsForClassify(['A', 'B']), /「A」/)
})

test('parseClassifyLabel：抽标签', () => {
  assert.equal(parseClassifyLabel('task'), 'task')
  assert.equal(parseClassifyLabel('标签：chat'), 'chat')
  assert.equal(parseClassifyLabel('teach_end\n'), 'teach_end')
  assert.equal(parseClassifyLabel(''), null)
})

test('localClassify 兜底：明确口令仍可用', () => {
  assert.equal(localClassify('你学会记录心情了吗?'), 'chat')
  assert.equal(localClassify('会不会保存文件'), 'chat')
  assert.equal(isSkillStatusQuestion('你学会记录心情了吗?'), true)
  assert.equal(isSkillStatusQuestion('我教过你去刷B站'), false)
  assert.equal(localClassify('今天天气真好'), 'chat')
  assert.equal(localClassify('看一眼桌面'), 'glance')
  assert.equal(localClassify('盯着屏幕看 60 秒'), 'glance')
  assert.equal(localClassify('我教你一下保存'), 'teach')
  assert.equal(localClassify('教完了'), 'teach_end')
  assert.equal(localClassify('把窗口最小化'), 'task')
  assert.equal(localClassify('执行一下记录每日心情'), 'task')
  assert.equal(localClassify('用你学会的去刷B站'), 'task')
  assert.equal(localClassify('新开一个窗口聊天'), 'new_session')
  assert.equal(localClassify('开启一个新的窗口'), 'new_session')
  assert.equal(regexClassifyFallback('教完了', { teaching: true }), 'teach_coach')
  assert.equal(localClassify('随便纠正一句', { teaching: true }), 'teach_coach')
})

test('已学目标 + 聊N轮 / 聊聊天 → 本地 task（不必写执行一下）', () => {
  const goals = ['和豆包聊天', '记录每日心情']
  assert.equal(hasSkillReplaySoftCue('和豆包姐姐聊聊天,学习一下聊天技巧,沟通3轮'), true)
  assert.equal(
    isLearnedGoalReplayIntent('和豆包姐姐聊聊天,学习一下聊天技巧,沟通3轮', goals),
    true,
  )
  assert.equal(
    localClassify('和豆包姐姐聊聊天,学习一下聊天技巧,沟通3轮', { learnedGoals: goals }),
    'task',
  )
  // 无已学列表时仍当闲聊（避免误干活）
  assert.equal(localClassify('和豆包姐姐聊聊天,沟通3轮', { learnedGoals: [] }), 'chat')
  // 只问状态仍 chat
  assert.equal(localClassify('你会和豆包聊天吗', { learnedGoals: goals }), 'chat')
  // 参谋类无「聊N轮」气味 → 不本地 task（留给 hybrid 叫醒）
  assert.equal(
    localClassify('帮我参谋一下怎么跟豆包打招呼', { learnedGoals: ['与豆包姐姐聊天'] }),
    'chat',
  )
})

test('classifyUtterance：新开窗本地优先，不叫醒模型', async () => {
  let woke = 0
  const r = await classifyUtterance({ fake: true }, '开启一个新的窗口', {
    wake: async () => {
      woke += 1
      return { ok: true, sessionId: 's' }
    },
    waitReply: async () => ({ ok: true, text: 'chat' }),
  })
  assert.equal(r.label, 'new_session')
  assert.equal(r.via, 'local')
  assert.equal(woke, 0)
})

test('hybrid：短问候不叫醒；模糊干活才叫醒', async () => {
  const prev = process.env.DSH_PET_ENHANCE_CLASSIFY
  delete process.env.DSH_PET_ENHANCE_CLASSIFY
  assert.equal(classifyMode(), 'hybrid')
  assert.equal(shouldEscalateChatToModel('你好'), false)
  assert.equal(shouldEscalateChatToModel('帮我参谋一下怎么跟豆包打招呼'), true)
  // 「按上次学的…」本地直接 task，不必叫醒
  assert.equal(localClassify('按上次学的帮我和豆包闲聊几句'), 'task')

  let woke = 0
  const hi = await classifyUtterance({ fake: true }, '你好', {
    wake: async () => { woke += 1; return { ok: true, sessionId: 's' } },
    waitReply: async () => ({ ok: true, text: 'task' }),
  })
  assert.equal(hi.label, 'chat')
  assert.equal(hi.via, 'local')
  assert.equal(woke, 0)

  const localRun = await classifyUtterance({ fake: true }, '按上次学的帮我和豆包闲聊几句', {
    wake: async () => { woke += 1; return { ok: true, sessionId: 's' } },
    waitReply: async () => ({ ok: true, text: 'chat' }),
  })
  assert.equal(localRun.label, 'task')
  assert.equal(localRun.via, 'local')
  assert.equal(woke, 0)

  // 无「执行一下」但带已学目标 + 沟通3轮 → 本地 task，不叫醒分流模型
  const soft = await classifyUtterance(
    { fake: true },
    '和豆包姐姐聊聊天,学习一下聊天技巧,沟通3轮',
    {
      learnedGoals: ['和豆包聊天'],
      wake: async () => { woke += 1; return { ok: true, sessionId: 's' } },
      waitReply: async () => ({ ok: true, text: 'chat' }),
    },
  )
  assert.equal(soft.label, 'task')
  assert.equal(soft.via, 'local')
  assert.equal(woke, 0)

  const r = await classifyUtterance({ fake: true }, '帮我参谋一下怎么跟豆包打招呼', {
    learnedGoals: ['与豆包姐姐聊天'],
    wake: async (_ctx, opts) => {
      woke += 1
      assert.match(opts.text, /与豆包姐姐聊天/)
      return { ok: true, sessionId: 's' }
    },
    waitReply: async () => ({ ok: true, text: 'task' }),
  })
  assert.equal(r.label, 'task')
  assert.equal(r.via, 'llm')
  assert.equal(woke, 1)
  if (prev === undefined) delete process.env.DSH_PET_ENHANCE_CLASSIFY
  else process.env.DSH_PET_ENHANCE_CLASSIFY = prev
})

test('classifyUtterance：模型失败回落 local', async () => {
  const r = await classifyUtterance({ fake: true }, '看一眼桌面', {
    mode: 'llm',
    wake: async () => ({ ok: false, reason: 'no-session' }),
  })
  assert.equal(r.label, 'glance')
  assert.equal(r.via, 'local')
})

test('classifyUtterance：mode=local 不叫醒', async () => {
  let woke = 0
  const r = await classifyUtterance({ fake: true }, '你学会记录心情了吗?', {
    mode: 'local',
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
  const r = await classifyUtterance({}, '帮我参谋一下怎么跟豆包打招呼', {
    complete: async () => 'chat',
  })
  assert.equal(r.label, 'chat')
  assert.equal(r.via, 'inject')
})
