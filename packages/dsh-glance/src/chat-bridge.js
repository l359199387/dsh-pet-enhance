/**
 * 把小瞥能力接到 dsh-pet 自带对话上（悬停按 L / Ctrl+Shift+L）。
 *
 * 不另开输入框：用户继续用 dsh-pet 聊；我们轮询 `/chat` 记忆，
 * 一旦用户提到看屏，就抓一帧并通过 `/broadcast` 把事实塞进宠物气泡。
 *
 * @module src/chat-bridge.js
 */

import { callDshPet } from './dsh-pet.js'
import { captureFrame } from './capture.js'

export const GLANCE_INTENT_RE =
  /看(?:一眼|看|下)?(?:我的)?屏幕|屏幕上|帮我看|截(?:个|一)?图|现在(?:的)?(?:桌面|屏幕)|这个窗口|窗口里|glance/i

export function isGlanceIntent(text) {
  return GLANCE_INTENT_RE.test(String(text ?? ''))
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return { content: m.content.trim(), ts: Number(m.ts) || 0 }
    }
  }
  return null
}

async function withLock(pet, fn) {
  const lockRes = await callDshPet(`/lock?pet=${encodeURIComponent(pet)}`, {
    method: 'POST',
    body: {},
    timeoutMs: 5_000,
  })
  const lockId = lockRes.data?.lockId
  if (!lockRes.ok || !lockId) {
    return { ok: false, error: 'lock-failed', detail: lockRes }
  }
  try {
    return await fn(lockId)
  } finally {
    await callDshPet(`/lock/release?pet=${encodeURIComponent(pet)}`, {
      method: 'POST',
      body: { lockId },
      timeoutMs: 3_000,
    }).catch(() => {})
  }
}

/**
 * @param {{
 *   sidecar?: object | (() => object | null | undefined),
 *   home: string,
 *   log?: (m: string) => void,
 *   petId?: string,
 *   intervalMs?: number,
 *   capture?: typeof captureFrame,
 * }} options
 */
export function createChatBridge(options) {
  const pet = options.petId || 'main'
  const log = options.log ?? (() => {})
  const intervalMs = options.intervalMs ?? 2_000
  const capture = options.capture ?? captureFrame
  let timer = null
  let stopped = false
  let lastTs = 0
  let lastContent = ''
  let busy = false

  async function handleIntent(userText) {
    busy = true
    try {
      await callDshPet('/work-status', {
        method: 'POST',
        body: { state: 'working', task: 'glance' },
      }).catch(() => {})

      let shot
      try {
        const sidecar = typeof options.sidecar === 'function'
          ? options.sidecar()
          : options.sidecar
        shot = await capture({
          sidecar,
          quality: 'low',
          home: options.home,
          timeoutMs: 25_000,
        })
      } catch (e) {
        const msg = `我去看屏幕了，但没看成：${e?.message ?? e}`
        log(`chat-bridge 抓屏失败：${msg}`)
        await withLock(pet, async (lockId) => callDshPet(
          `/broadcast?pet=${encodeURIComponent(pet)}&lock=${encodeURIComponent(lockId)}`,
          { method: 'POST', body: { text: msg }, timeoutMs: 8_000 },
        ))
        return
      }

      const screen = shot.screen?.w && shot.screen?.h
        ? `${shot.screen.w}×${shot.screen.h}`
        : '未知尺寸'
      const where = shot.window?.title
        ? `窗口「${shot.window.title}」`
        : `整屏 ${screen}`
      const text =
        `我看了一眼：${where} → ${shot.width}×${shot.height}（${shot.quality} · ${shot.engine} · ${shot.ms}ms）。`
        + '图已经在工具侧；你若要我描述细节，再说具体一点。'

      await withLock(pet, async (lockId) => callDshPet(
        `/broadcast?pet=${encodeURIComponent(pet)}&lock=${encodeURIComponent(lockId)}`,
        { method: 'POST', body: { text }, timeoutMs: 8_000 },
      ))
      log(`chat-bridge 已把看屏结果广播给 dsh-pet（${userText.slice(0, 40)}）`)
    } finally {
      await callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})
      busy = false
    }
  }

  async function tick() {
    if (stopped || busy) return
    const res = await callDshPet(`/chat?pet=${encodeURIComponent(pet)}&rounds=4`, {
      method: 'GET',
      timeoutMs: 4_000,
    })
    if (!res.ok) return
    const user = lastUserMessage(res.data?.messages)
    if (!user) return
    if (user.ts === lastTs && user.content === lastContent) return
    // 第一次只建基线，避免插件刚装上就把历史里旧的「看屏幕」又执行一遍。
    if (lastTs === 0 && lastContent === '') {
      lastTs = user.ts
      lastContent = user.content
      return
    }
    lastTs = user.ts
    lastContent = user.content
    if (!isGlanceIntent(user.content)) return
    await handleIntent(user.content)
  }

  function start() {
    if (timer) return
    stopped = false
    timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
    tick().catch(() => {})
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  return { start, stop, tick, isGlanceIntent }
}
