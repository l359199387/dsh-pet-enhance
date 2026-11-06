/**
 * 把小蓝鲸能力接到 dsh-pet 自带对话上（悬停按 L / Ctrl+Shift+L）。
 *
 * B2：会话记忆与气泡归 dsh-pet；我们只做看屏闭环 + episode 落盘 + 附图时注入人格。
 *
 * @module src/chat-bridge.js
 */

import {
  broadcastToDshPet,
  callDshPet,
  chatWithDshPet,
} from './dsh-pet.js'
import { captureFrame } from './capture.js'
import { appendEpisode, buildGlanceEpisode } from './episode.js'
import { glancePersonaBlock } from './persona.js'
import {
  GLANCE_FOLLOWUP_PREFIX,
  GLANCE_INTENT_RE,
  isGlanceIntent,
  shouldSkipGlanceBridge,
} from './intent.js'

export {
  GLANCE_FOLLOWUP_PREFIX,
  GLANCE_INTENT_RE,
  isGlanceIntent,
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

export function followUpPrompt(userText, shot) {
  const where = shot.window?.title
    ? `当前焦点窗口「${shot.window.title}」`
    : (shot.screen?.w && shot.screen?.h
      ? `整屏 ${shot.screen.w}×${shot.screen.h}`
      : '整屏')
  return (
    `${GLANCE_FOLLOWUP_PREFIX}`
    + `用户刚说「${String(userText).slice(0, 80)}」。`
    + `我已抓到${where} → ${shot.width}×${shot.height}。`
    + '请根据附图用一两句口语告诉用户桌面/屏幕上现在有什么，说具体内容。'
    + `\n\n${glancePersonaBlock()}`
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
 *   onLooking?: () => void,
 *   onIdle?: () => void,
 *   recordEpisode?: boolean,
 *   pollChat?: boolean,
 *   greetOnStart?: boolean,
 * }} options
 */
export function createChatBridge(options) {
  const pet = options.petId || 'main'
  const log = options.log ?? (() => {})
  const intervalMs = options.intervalMs ?? 2_000
  const capture = options.capture ?? captureFrame
  const recordEpisode = options.recordEpisode !== false
  const pollChat = options.pollChat !== false
  const greetOnStart = options.greetOnStart !== false
  let timer = null
  let greetTimer = null
  let stopped = false
  let lastTs = 0
  let lastContent = ''
  let busy = false
  let greeted = false

  async function remember(episodeInput) {
    if (!recordEpisode || !options.home) return
    const episode = buildGlanceEpisode(episodeInput)
    const r = await appendEpisode(options.home, episode)
    if (!r.ok) log(`chat-bridge episode 落盘失败：${r.error}`)
    else if (r.skipped) log('chat-bridge episode 跳过（敏感窗口）')
  }

  async function handleIntent(userText) {
    busy = true
    const t0 = Date.now()
    try {
      try { options.onLooking?.() } catch { /* 状态旁路 */ }

      await callDshPet('/work-status', {
        method: 'POST',
        body: { state: 'working', task: 'glance' },
      }).catch(() => {})

      const notice = await broadcastToDshPet('好，我瞅一眼桌面…', { pet, duration: 6_000 })
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
        await remember({
          userText,
          result: 'capture-failed',
          durMs: Date.now() - t0,
          error: e?.message ?? String(e),
        })
        return
      }

      if (!shot?.png || !Buffer.isBuffer(shot.png)) {
        await broadcastToDshPet('抓到了，但图数据坏了。', { pet })
        await remember({
          userText,
          shot,
          result: 'bad-png',
          durMs: Date.now() - t0,
          error: 'bad-png',
        })
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
        const screen = shot.screen?.w && shot.screen?.h
          ? `${shot.screen.w}×${shot.screen.h}`
          : '未知尺寸'
        const where = shot.window?.title
          ? `窗口「${shot.window.title}」`
          : `整屏 ${screen}`
        const fallback =
          `我看了一眼：${where} → ${shot.width}×${shot.height}`
          + `（${shot.quality} · ${shot.engine} · ${shot.ms}ms）。`
        await broadcastToDshPet(fallback, { pet, duration: 14_000 })
        await remember({
          userText,
          shot,
          result: 'chat-failed',
          durMs: Date.now() - t0,
          error: reason,
          reply: fallback,
        })
        return
      }

      const reply = typeof chat.data?.text === 'string' ? chat.data.text : ''
      lastContent = prompt
      lastTs = Date.now()
      log(`chat-bridge 已附图交给 dsh-pet 开口（${userText.slice(0, 40)}）`)
      await remember({
        userText,
        shot,
        result: 'ok',
        durMs: Date.now() - t0,
        reply,
      })
    } finally {
      await callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})
      try { options.onIdle?.() } catch { /* ignore */ }
      busy = false
    }
  }

  async function tick() {
    if (stopped || busy) return
    const res = await callDshPet(`/chat?pet=${encodeURIComponent(pet)}&rounds=8`, {
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
    if (shouldSkipGlanceBridge(user.content)) return
    if (!isGlanceIntent(user.content)) return
    await handleIntent(user.content)
  }

  async function greetOnce() {
    if (greeted || stopped) return
    greeted = true
    const r = await broadcastToDshPet(
      '小蓝鲸已接入：随便聊；想看屏幕、教我操作、或让我动手，直接说就行。',
      { pet, duration: 10_000 },
    )
    if (!r.ok || r.data?.ok === false) {
      log(`chat-bridge 接入提示失败：${r.error || r.data?.reason || r.status}`)
      greeted = false
    }
  }

  function start() {
    if (timer || greetTimer) return
    stopped = false
    if (pollChat) {
      timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
      tick().catch(() => {})
    }
    // 等 origin / dsh-pet 就绪后再冒泡一次，避免启动瞬间 404；stop 时清掉。
    if (greetOnStart) {
      greetTimer = setTimeout(() => {
        greetTimer = null
        greetOnce().catch(() => {})
      }, 2_500)
    }
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    if (greetTimer) clearTimeout(greetTimer)
    greetTimer = null
  }

  return { start, stop, tick, handleIntent, isGlanceIntent, followUpPrompt }
}
