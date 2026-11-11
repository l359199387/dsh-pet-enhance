/**
 * agent-bridge：干活意图粗筛 + 叫醒主会话 Agent。
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentWakePrompt,
  createAgentBridge,
  isComputerTaskIntent,
  shouldWakeAgent,
  AGENT_WAKE_PREFIX,
} from '../src/agent-bridge.js'
import { GLANCE_FOLLOWUP_PREFIX, shouldSkipGlanceBridge } from '../src/intent.js'
import { setDshPetBaseUrl } from '../src/dsh-pet.js'
import { saveSettings } from '../src/settings.js'

const realFetch = globalThis.fetch
const home = mkdtempSync(join(tmpdir(), 'glance-agent-'))
const petMemoryPath = join(home, 'memory.json')

afterEach(() => {
  globalThis.fetch = realFetch
  setDshPetBaseUrl('')
})

test('isComputerTaskIntent：干活命中，闲聊/看屏/回声不命中', () => {
  assert.equal(isComputerTaskIntent('把 deepseekharness 最小化'), true)
  assert.equal(isComputerTaskIntent('帮我点一下保存'), true)
  assert.equal(isComputerTaskIntent('请把语言改成中文'), true)
  assert.equal(isComputerTaskIntent('帮我在记事本输入你好'), true)
  assert.equal(isComputerTaskIntent('看一眼我的桌面'), false)
  assert.equal(isComputerTaskIntent('今天吃什么'), false)
  assert.equal(isComputerTaskIntent('你是谁'), false)
  assert.equal(isComputerTaskIntent(`${AGENT_WAKE_PREFIX}假消息`), false)
  assert.equal(isComputerTaskIntent(`${GLANCE_FOLLOWUP_PREFIX}假消息`), false)
  assert.equal(shouldWakeAgent('帮我关掉这个窗口'), true)
  assert.equal(shouldSkipGlanceBridge('帮我关掉这个窗口'), true)
  assert.equal(shouldSkipGlanceBridge('看一眼桌面'), false)
})

test('buildAgentWakePrompt：含用户原话与 computer-use 指引', () => {
  const p = buildAgentWakePrompt('把记事本最小化')
  assert.ok(p.startsWith(AGENT_WAKE_PREFIX))
  assert.ok(p.includes('把记事本最小化'))
  assert.match(p, /windows_computer_use_/)
  assert.match(p, /禁止.*glance|禁止.*act/)
  assert.match(p, /电脑操控/)
})

test('交办不再要求允许动手：直接叫醒并回灌气泡', async () => {
  setDshPetBaseUrl('http://127.0.0.1:9')
  await saveSettings(home, { actEnabled: false })
  const wakes = []
  const bubbles = []
  let round = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const method = init?.method || 'GET'
    if (u.includes('/chat') && method === 'GET') {
      round += 1
      const messages = round === 1
        ? [{ role: 'user', content: '旧消息', ts: 1 }]
        : [
          { role: 'user', content: '旧消息', ts: 1 },
          { role: 'user', content: '帮我点一下确定', ts: 2 },
        ]
      return { ok: true, status: 200, async json() { return { ok: true, messages } } }
    }
    if (u.includes('/broadcast') && method === 'POST') {
      let body = {}
      try { body = JSON.parse(init.body) } catch { /* ignore */ }
      bubbles.push(body.text || body.message || '')
      return { ok: true, status: 200, async json() { return { ok: true } } }
    }
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }

  const bridge = createAgentBridge({
    ctx: {},
    home,
    petMemoryPath,
    intervalMs: 60_000,
    log() {},
    isComputerUseInstalled: () => true,
    getPreferredSessionId: () => 'sess-9',
    prepareSession: async () => ({ sessionId: 'fresh-9', fresh: true }),
    wake: async (_ctx, opts) => {
      wakes.push(opts)
      return { ok: true, sessionId: 'fresh-9' }
    },
    waitReply: async () => ({ ok: true, text: '请你自己点确定；我这边不代点鼠标。' }),
  })

  await bridge.tick()
  await bridge.tick()
  assert.equal(wakes.length, 1)
  assert.ok(String(wakes[0].text).includes('帮我点一下确定'))
  assert.match(String(wakes[0].text), /禁止/)
  assert.equal(wakes[0].sessionId, 'fresh-9')
  assert.equal(wakes[0].preferredId, 'fresh-9')
  assert.ok(bubbles.some((t) => String(t).includes('不代点鼠标')))
  const mem = JSON.parse(readFileSync(petMemoryPath, 'utf8'))
  assert.match(mem.main.main.messages.at(-1).content, /不代点鼠标/)
})
