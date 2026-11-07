import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isComputerTaskIntent,
  isNewSessionIntent,
  isRunAutomationIntent,
  isTeachEndIntent,
  isTeachStartIntent,
  shouldSkipAgentBridge,
  shouldSkipGlanceBridge,
} from '../src/intent.js'
import { shouldWakeAgent as agentShouldWake } from '../src/agent-bridge.js'

test('教学口令识别', () => {
  assert.equal(isTeachStartIntent('我教你一下怎么保存'), true)
  assert.equal(isTeachStartIntent('学一下我的操作'), true)
  assert.equal(isTeachEndIntent('教完了'), true)
  assert.equal(isTeachEndIntent('按刚才教的去做'), true)
  assert.equal(isTeachStartIntent('看一眼桌面'), false)
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
  assert.equal(isNewSessionIntent('今天天气真好'), false)
  assert.equal(shouldSkipGlanceBridge('新开一个窗口聊天'), true)
  assert.equal(shouldSkipAgentBridge('新开一个窗口聊天'), true)
})
