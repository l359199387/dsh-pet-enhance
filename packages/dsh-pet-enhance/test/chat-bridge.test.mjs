/**
 * chat-bridge：意图识别 + 轮询 /chat 后叫醒主会话 computer-use 观察。
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createChatBridge, isGlanceIntent, GLANCE_FOLLOWUP_PREFIX } from '../src/chat-bridge.js'
import { setDshPetBaseUrl } from '../src/dsh-pet.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  setDshPetBaseUrl('')
})

test('isGlanceIntent：看屏/桌面相关命中，闲聊与 follow-up 不命中', () => {
  assert.equal(isGlanceIntent('帮我看一眼屏幕'), true)
  assert.equal(isGlanceIntent('看一眼我的屏幕'), true)
  assert.equal(isGlanceIntent('看一眼我的桌面'), true)
  assert.equal(isGlanceIntent('看看桌面'), true)
  assert.equal(isGlanceIntent('帮我看桌面'), true)
  assert.equal(isGlanceIntent('桌面上有什么'), true)
  assert.equal(isGlanceIntent('看看屏幕上写了什么'), true)
  assert.equal(isGlanceIntent('截个图'), true)
  assert.equal(isGlanceIntent('glance please'), true)
  assert.equal(isGlanceIntent('盯着屏幕看 60 秒'), true)
  assert.equal(isGlanceIntent('陪我看一会儿屏幕'), true)
  assert.equal(isGlanceIntent('今天吃什么'), false)
  assert.equal(isGlanceIntent('帮我看一下天气预报'), false)
  assert.equal(isGlanceIntent('屏幕上是记事本。'), false)
  assert.equal(isGlanceIntent('这件事我还没学会。最近技能：「和豆包姐姐聊天」。'), false)
  assert.equal(isGlanceIntent(`${GLANCE_FOLLOWUP_PREFIX}请描述`), false)
  assert.equal(isGlanceIntent(''), false)
})

test('isWatchIntent / parseWatchSeconds：盯屏口令', async () => {
  const { isWatchIntent, parseWatchSeconds } = await import('../src/intent.js')
  assert.equal(isWatchIntent('盯着屏幕看 60 秒'), true)
  assert.equal(isWatchIntent('陪看 30s'), true)
  assert.equal(isWatchIntent('看一眼桌面'), false)
  assert.equal(parseWatchSeconds('盯着屏幕看 60 秒'), 60)
  assert.equal(parseWatchSeconds('watch 90秒'), 90)
  assert.equal(parseWatchSeconds('盯一会儿'), 30)
})

test('createChatBridge：首次 tick 只建基线，不叫醒', async () => {
  setDshPetBaseUrl('http://127.0.0.1:9')
  const paths = []
  let wakes = 0
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

  const bridge = createChatBridge({
    home: 'C:\\tmp\\glance-test',
    intervalMs: 60_000,
    recordEpisode: false,
    log() {},
    isComputerUseInstalled: () => true,
    wake: async () => {
      wakes += 1
      return { ok: true, sessionId: 's1' }
    },
  })

  await bridge.tick()
  assert.equal(wakes, 0)
  assert.ok(paths.some((p) => p.includes('/chat')))
  assert.ok(!paths.some((p) => p.includes('/broadcast')))
})

test('createChatBridge：新用户句命中意图 → 叫醒 computer-use 观察', async () => {
  setDshPetBaseUrl('http://127.0.0.1:9')
  let round = 0
  const paths = []
  const wakes = []
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
    if (u.includes('/broadcast')) {
      return { ok: true, status: 200, async json() { return { ok: true } } }
    }
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }

  const bridge = createChatBridge({
    home: 'C:\\tmp\\glance-test',
    intervalMs: 60_000,
    recordEpisode: false,
    log() {},
    isComputerUseInstalled: () => true,
    prepareSession: async () => ({ sessionId: 'sess-look', fresh: true }),
    wake: async (_ctx, opts) => {
      wakes.push(opts)
      return { ok: true, sessionId: 'sess-look' }
    },
    waitReply: async () => ({ ok: true, text: '屏幕上是记事本。' }),
  })

  await bridge.tick()
  assert.equal(wakes.length, 0)

  await bridge.tick()
  assert.equal(wakes.length, 1)
  assert.match(String(wakes[0].text), /windows_computer_use_/)
  assert.match(String(wakes[0].text), /看一眼我的屏幕/)
  assert.match(String(wakes[0].text), /禁止.*glance|禁止.*act/)
  assert.ok(paths.some((p) => p.includes('POST') && p.includes('/broadcast')))
  assert.ok(!paths.some((p) => p.includes('POST') && p.includes('/chat') && p.includes('surface=any')))
})
