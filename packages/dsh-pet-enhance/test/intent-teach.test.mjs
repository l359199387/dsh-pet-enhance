import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isComputerTaskIntent,
  isEnhanceSelfTalk,
  isNewSessionIntent,
  isRunAutomationIntent,
  isTeachEndIntent,
  isTeachStartIntent,
  shouldSkipAgentBridge,
  shouldSkipGlanceBridge,
  TEACH_DONE_CHAT_PREFIX,
} from '../src/intent.js'
import { shouldWakeAgent as agentShouldWake } from '../src/agent-bridge.js'

test('教学口令识别', () => {
  assert.equal(isTeachStartIntent('我教你一下怎么保存'), true)
  assert.equal(isTeachStartIntent('我来教你一下看看微博热搜'), true)
  assert.equal(isTeachStartIntent('学一下我的操作'), true)
  assert.equal(isTeachStartIntent('开始带教'), true)
  assert.equal(isTeachEndIntent('教完了'), true)
  assert.equal(isTeachEndIntent('我教完了'), true)
  assert.equal(isTeachEndIntent('教学结束'), true)
  assert.equal(isTeachEndIntent('加入技能中'), true)
  assert.equal(isTeachEndIntent('按刚才教的去做'), true)
  assert.equal(isTeachStartIntent('看一眼桌面'), false)
  // 收束口令绝不能开新一轮
  assert.equal(isTeachStartIntent('我教完了'), false)
  assert.equal(isTeachStartIntent('教学结束'), false)
  // 学会后写入聊天的伪用户行绝不能再开带教
  assert.equal(isTeachStartIntent(`${TEACH_DONE_CHAT_PREFIX}加入技能中`), false)
  assert.equal(isTeachStartIntent('带教完成'), false)
  assert.equal(isEnhanceSelfTalk(`${TEACH_DONE_CHAT_PREFIX}加入技能中`), true)
})

test('带教收束本地优先：我教完了→done，不教了→abort', async () => {
  const { localCoachClearLabel, classifyCoachUtterance } = await import('../src/intent.js')
  assert.equal(localCoachClearLabel('我教完了'), 'done')
  assert.equal(localCoachClearLabel('教学结束'), 'done')
  assert.equal(localCoachClearLabel('加入技能中'), 'done')
  assert.equal(localCoachClearLabel('不教了'), 'abort')
  // 即使模型会回 step，本地也要做成 done
  assert.equal(await classifyCoachUtterance({}, '我教完了', {
    goal: '看微博热搜',
    wake: async () => ({ ok: true, sessionId: 's' }),
    waitReply: async () => ({ ok: true, text: 'step' }),
    log: () => {},
  }), 'done')
})

test('教学时 glance/agent 让路', () => {
  assert.equal(shouldSkipGlanceBridge('我教你一下'), true)
  assert.equal(shouldSkipAgentBridge('教完了'), true)
  assert.equal(agentShouldWake('我教你一下然后点保存'), false)
  assert.equal(agentShouldWake('帮我点保存'), true)
})

test('执行已学自动化口令', () => {
  assert.equal(isRunAutomationIntent('执行一下记录每日心情'), true)
  assert.equal(isRunAutomationIntent('去记录一下每日心情'), true)
  assert.equal(isComputerTaskIntent('去记录一下每日心情'), true)
  assert.equal(isRunAutomationIntent('去看看B站'), true)
  assert.equal(isRunAutomationIntent('继续去看看B站'), true)
  assert.equal(isRunAutomationIntent('继续去刷刷B站'), true)
  assert.equal(isComputerTaskIntent('继续去看看B站'), true)
  assert.equal(isRunAutomationIntent('用你学会的去刷B站'), true)
  assert.equal(isRunAutomationIntent('我教过你和豆包聊天'), true)
  assert.equal(isRunAutomationIntent('去看我学会的东西然后执行'), true)
  assert.equal(isComputerTaskIntent('用你学会的记录心情'), true)
  assert.equal(isRunAutomationIntent('今天天气真好'), false)
})

test('新开工作区聊天窗口口令', () => {
  assert.equal(isNewSessionIntent('新开一个窗口聊天'), true)
  assert.equal(isNewSessionIntent('开个新会话'), true)
  assert.equal(isNewSessionIntent('新建一个会话'), true)
  assert.equal(isNewSessionIntent('开启一个新的窗口'), true)
  assert.equal(isNewSessionIntent('开启一个新窗口'), true)
  assert.equal(isNewSessionIntent('打开一个新窗口'), true)
  assert.equal(isNewSessionIntent('今天天气真好'), false)
  assert.equal(shouldSkipGlanceBridge('新开一个窗口聊天'), true)
  assert.equal(shouldSkipAgentBridge('新开一个窗口聊天'), true)
})
