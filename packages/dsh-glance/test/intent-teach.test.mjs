import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
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
