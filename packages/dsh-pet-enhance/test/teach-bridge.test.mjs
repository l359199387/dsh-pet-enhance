import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildLearnedChatNotice,
  buildTeachDigestPrompt,
  isLikelyAddressBarNoise,
  isVagueReplayIntent,
  parseTeachDigestReply,
  shouldAttachTeachDigestImages,
} from '../src/teach-bridge.js'
import { AGENT_WAKE_PREFIX } from '../src/intent.js'

test('buildLearnedChatNotice：含目标与技能名', () => {
  const t = buildLearnedChatNotice({
    goal: '和豆包聊天',
    summary: '示范闲聊并看回复',
    fastPlan: '打开豆包会话直接说你好',
    skillName: 'chat-doubao',
  })
  assert.match(t, /我学会了「和豆包聊天」/)
  assert.match(t, /理解：/)
  assert.match(t, /更快做法：/)
  assert.match(t, /技能「chat-doubao」/)
  assert.match(t, /技能管理|dsh-mnemon/)
})

test('shouldAttachTeachDigestImages：键入为主不附图', () => {
  assert.equal(shouldAttachTeachDigestImages([
    { action: 'click' },
    { action: 'type', text: 'a' },
  ]), true)
  assert.equal(shouldAttachTeachDigestImages([
    { action: 'click' },
    { action: 'type' }, { action: 'type' }, { action: 'type' },
    { action: 'key' }, { action: 'key' }, { action: 'type' },
  ]), false)
  assert.equal(shouldAttachTeachDigestImages([
    { action: 'type' }, { action: 'key' },
  ]), false)
})

test('地址栏脏输入与模糊回放口令', () => {
  assert.equal(isLikelyAddressBarNoise('bilibli1'), true)
  assert.equal(isLikelyAddressBarNoise('dafeiyu1'), true)
  assert.equal(isLikelyAddressBarNoise('https://www.bilibili.com'), false)
  assert.equal(isLikelyAddressBarNoise('今天心情不错'), false)
  assert.equal(isVagueReplayIntent('再做一次'), true)
  assert.equal(isVagueReplayIntent('ibli1'), false)
  assert.equal(isVagueReplayIntent('继续去看看B站'), false)
})

test('parseTeachDigestReply：OK / NEED_MORE / FAST', () => {
  assert.equal(parseTeachDigestReply('NEED_MORE').needMore, true)
  assert.equal(parseTeachDigestReply('OK: 在记事本写心情').summary.includes('心情'), true)
  assert.match(parseTeachDigestReply('OK: 进B站\nFAST: 打开 bilibili.com').fastPlan, /bilibili/)
  assert.ok(buildTeachDigestPrompt('g', 'n', 3).startsWith(AGENT_WAKE_PREFIX))
  assert.match(buildTeachDigestPrompt('g', 'n', 3), /FAST/)
  const withClick = buildTeachDigestPrompt('g', 'n', [{
    role: 'click',
    name: '00-click-step0.png',
    click: {
      eventI: 0, action: 'click', screenX: 800, screenY: 450,
      imageX: 200, imageY: 200, imageW: 400, imageH: 400, mapped: true,
      crop: { x: 600, y: 250, w: 400, h: 400 },
    },
  }])
  assert.match(withClick, /图内坐标 \(200,200\)/)
})

// 录宏教学集成用例已废止；对话带教见 teach-coach-flow.test.mjs
