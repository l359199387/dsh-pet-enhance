/**
 * chat-bridge：意图识别 + 轮询 /chat 后抓屏，经 dsh-pet 开口。
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createChatBridge, isGlanceIntent, GLANCE_FOLLOWUP_PREFIX } from '../src/chat-bridge.js'
import { setDshPetBaseUrl } from '../src/dsh-pet.js'

const realFetch = globalThis.fetch
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

afterEach(() => {
  globalThis.fetch = realFetch
  setDshPetBaseUrl('')
})

test('isGlanceIntent：看屏相关命中，闲聊与 follow-up 不命中', () => {
  assert.equal(isGlanceIntent('帮我看一眼屏幕'), true)
  assert.equal(isGlanceIntent('看一眼我的屏幕'), true)
  assert.equal(isGlanceIntent('看看屏幕上写了什么'), true)
  assert.equal(isGlanceIntent('截个图'), true)
  assert.equal(isGlanceIntent('glance please'), true)
  assert.equal(isGlanceIntent('今天吃什么'), false)
  assert.equal(isGlanceIntent(`${GLANCE_FOLLOWUP_PREFIX}请描述`), false)
  assert.equal(isGlanceIntent(''), false)
})

test('createChatBridge：首次 tick 只建基线，不抓屏', async () => {
  setDshPetBaseUrl('http://127.0.0.1:9')
  const paths = []
  globalThis.fetch = async (url) => {
    paths.push(String(url))
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          messages: [{ role: 'user', content: '看一眼屏幕', ts: 100 }],
        }
      },
    }
  }

  let captured = 0
  const bridge = createChatBridge({
    home: 'C:\\tmp\\glance-test',
    intervalMs: 60_000,
    log() {},
    capture: async () => {
      captured += 1
      return { png: PNG, width: 800, height: 600, quality: 'low', engine: 'test', ms: 1, screen: { w: 1920, h: 1080 } }
    },
  })

  await bridge.tick()
  assert.equal(captured, 0)
  assert.ok(paths.some((p) => p.includes('/chat')))
  assert.ok(!paths.some((p) => p.includes('/broadcast')))
})

test('createChatBridge：新用户句命中意图 → 抓屏 + POST /chat 附图', async () => {
  setDshPetBaseUrl('http://127.0.0.1:9')
  let round = 0
  const paths = []
  let chatBody
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    paths.push(`${init?.method || 'GET'} ${u}`)
    if (u.includes('/chat') && (init?.method || 'GET') === 'GET') {
      round += 1
      const messages = round === 1
        ? [{ role: 'user', content: '你好', ts: 1 }]
        : [
          { role: 'user', content: '你好', ts: 1 },
          { role: 'assistant', content: '嗨', ts: 2 },
          { role: 'user', content: '看一眼我的屏幕', ts: 3 },
        ]
      return { ok: true, status: 200, async json() { return { ok: true, messages } } }
    }
    if (u.includes('/chat') && init?.method === 'POST') {
      chatBody = JSON.parse(init.body)
      return { ok: true, status: 200, async json() { return { ok: true, text: '屏幕上是记事本' } } }
    }
    if (u.includes('/broadcast')) {
      return { ok: true, status: 200, async json() { return { ok: true } } }
    }
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }

  let captured = 0
  const bridge = createChatBridge({
    home: 'C:\\tmp\\glance-test',
    intervalMs: 60_000,
    log() {},
    capture: async () => {
      captured += 1
      return {
        png: PNG,
        width: 798,
        height: 449,
        quality: 'low',
        engine: 'test',
        ms: 12,
        screen: { w: 1920, h: 1080 },
        window: { title: '记事本' },
      }
    },
  })

  await bridge.tick()
  assert.equal(captured, 0)

  await bridge.tick()
  assert.equal(captured, 1)
  assert.ok(paths.some((p) => p.includes('POST') && p.includes('/broadcast')))
  assert.ok(paths.some((p) => p.includes('POST') && p.includes('/chat') && p.includes('surface=any')))
  assert.equal(chatBody?.attachment?.mediaType, 'image/png')
  assert.ok(String(chatBody?.text || '').startsWith(GLANCE_FOLLOWUP_PREFIX))
})
