/**
 * 把小瞥能力接到 dsh-pet 自带对话上（悬停按 L / Ctrl+Shift+L）。
 *
 * 不另开输入框：用户继续用 dsh-pet 聊；我们轮询 `/chat` 记忆，
 * 一旦用户提到看屏，就抓一帧，再 `POST /chat` 附图让宠物自己开口描述。
 * 失败时用 `/broadcast` 把原因吐到气泡。
 *
 * @module src/chat-bridge.js
 */

import {
  broadcastToDshPet,
  callDshPet,
  chatWithDshPet,
} from './dsh-pet.js'
import { captureFrame } from './capture.js'

export const GLANCE_INTENT_RE =
  /看(?:一眼|看|下)?(?:我的)?屏幕|屏幕上|帮我看|截(?:个|一)?图|现在(?:的)?(?:桌面|屏幕)|这个窗口|窗口里|glance/i

/** 我们二次投喂的提示词前缀——不得命中 GLANCE_INTENT_RE，避免死循环。 */
export const GLANCE_FOLLOWUP_PREFIX = '【小瞥已附上刚才的画面】'

export function isGlanceIntent(text) {
  const s = String(text ?? '')
  if (s.startsWith(GLANCE_FOLLOWUP_PREFIX)) return false
  return GLANCE_INTENT_RE.test(s)
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

function followUpPrompt(userText, shot) {
  const where = shot.window?.title
    ? `当前焦点窗口「${shot.window.title}」`
    : (shot.screen?.w && shot.screen?.h
      ? `整屏 ${shot.screen.w}×${shot.screen.h}`
      : '整屏')
  return (
    `${GLANCE_FOLLOWUP_PREFIX}`
    + `用户刚说「${userText.slice(0, 80)}」。`
    + `我已抓到${where} → ${shot.width}×${shot.height}。`
    + '请根据附图用一两句口语告诉用户屏幕上现在有什么，不要提你是插件。'
  )
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

      // 先用气泡报一声（无锁也可投；surface=any）
      const notice = await broadcastToDshPet('好，我看一眼屏幕…', { pet, duration: 6_000 })
      if (!notice.ok || notice.data?.ok === false) {
        log(`chat-bridge 预告气泡失败：${notice.error || notice.data?.reason || notice.status}`)
      }

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
        await broadcastToDshPet(msg, { pet, duration: 12_000 })
        return
      }

      if (!shot?.png || !Buffer.isBuffer(shot.png)) {
        await broadcastToDshPet('抓到了，但图数据坏了。', { pet })
        return
      }

      const prompt = followUpPrompt(userText, shot)
      const chat = await chatWithDshPet(prompt, {
        pet,
        attachment: {
          mediaType: 'image/png',
          data: shot.png.toString('base64'),
        },
        timeoutMs: 120_000,
      })

      if (!chat.ok || chat.data?.ok === false) {
        const reason = chat.data?.reason || chat.error || `http-${chat.status}`
        const msg = `图有了，但宠物没能开口（${reason}）。`
        log(`chat-bridge 附图对话失败：${msg}`)
        // 退路：至少把尺寸/窗口事实说出来
        const screen = shot.screen?.w && shot.screen?.h
          ? `${shot.screen.w}×${shot.screen.h}`
          : '未知尺寸'
        const where = shot.window?.title
          ? `窗口「${shot.window.title}」`
          : `整屏 ${screen}`
        await broadcastToDshPet(
          `我看了一眼：${where} → ${shot.width}×${shot.height}（${shot.quality} · ${shot.engine} · ${shot.ms}ms）。`,
          { pet, duration: 14_000 },
        )
        return
      }

      // 对话成功时 dsh-pet 自己会写 say 气泡；再记下基线，避免下一拍把我们的 follow-up 当新意图
      lastContent = prompt
      lastTs = Date.now()
      log(`chat-bridge 已附图交给 dsh-pet 开口（${userText.slice(0, 40)}）`)
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
    if (!res.ok) {
      if (res.error) log(`chat-bridge 读 /chat 失败：${res.error}`)
      return
    }
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
