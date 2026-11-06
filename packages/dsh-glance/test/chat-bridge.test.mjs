/**
 * chat-bridge：意图识别 + 轮询 /chat 后抓屏广播。
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createChatBridge, isGlanceIntent } from '../src/chat-bridge.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

test('isGlanceIntent：看屏相关命中，闲聊不命中', () => {
  assert.equal(isGlanceIntent('帮我看一眼屏幕'), true)
  assert.equal(isGlanceIntent('看看屏幕上写了什么'), true)
  assert.equal(isGlanceIntent('截个图'), true)
  assert.equal(isGlanceIntent('这个窗口里是啥'), true)
  assert.equal(isGlanceIntent('glance please'), true)
  assert.equal(isGlanceIntent('今天吃什么'), false)
  assert.equal(isGlanceIntent(''), false)
  assert.equal(isGlanceIntent(null), false)
})

test('createChatBridge：首次 tick 只建基线，不抓屏', async () => {
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
      return {
        width: 800,
        height: 600,
        quality: 'low',
        engine: 'test',
        ms: 1,
        screen: { w: 1920, h: 1080 },
        window: null,
      }
    },
  })

  await bridge.tick()
  assert.equal(captured, 0)
  assert.ok(paths.some((p) => p.includes('/chat')))
  assert.ok(!paths.some((p) => p.includes('/broadcast')))
})

test('createChatBridge：新用户句命中意图 → capture + broadcast', async () => {
  let round = 0
  const paths = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    paths.push(`${init?.method || 'GET'} ${u}`)
    if (u.includes('/chat')) {
      round += 1
      const messages = round === 1
        ? [{ role: 'user', content: '你好', ts: 1 }]
        : [
          { role: 'user', content: '你好', ts: 1 },
          { role: 'assistant', content: '嗨', ts: 2 },
          { role: 'user', content: '帮我看一眼屏幕', ts: 3 },
        ]
      return { ok: true, status: 200, async json() { return { ok: true, messages } } }
    }
    if (u.includes('/lock')) {
      return { ok: true, status: 200, async json() { return { ok: true, lockId: 'L1' } } }
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
  assert.ok(paths.some((p) => p.includes('/lock')))
})
