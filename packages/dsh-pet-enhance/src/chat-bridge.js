/**
 * 把小蓝鲸能力接到 dsh-pet 自带对话上（悬停按 L / Ctrl+Shift+L）。
 *
 * 0.5.1+：看屏意图改为叫醒主会话，用 windows_computer_use_* 观察（不再本地抓图附图）。
 *
 * @module src/chat-bridge.js
 */

import {
  broadcastToDshPet,
  callDshPet,
} from './dsh-pet.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendEpisode, buildGlanceEpisode } from './episode.js'
import { glancePersonaBlock } from './persona.js'
import {
  GLANCE_FOLLOWUP_PREFIX,
  GLANCE_INTENT_RE,
  isGlanceIntent,
  isWatchIntent,
  parseWatchSeconds,
  shouldSkipGlanceBridge,
} from './intent.js'
import { sayConclusionToPet } from './pet-chat-memory.js'
import { wakeSession, waitAssistantReply } from './wake-session.js'
import { prepareFreshRunSession } from './session-spawn.js'
import {
  buildComputerUseObservePrompt,
  COMPUTER_USE_MISSING_BUBBLE,
  isComputerUseInstalled as detectComputerUse,
} from './computer-use-delegate.js'

/** 最近一次盯屏/看屏拼图落盘，方便用户直接打开看。 */
export function latestWatchPngPath(home) {
  return join(home, 'cache', 'watch-latest.png')
}

export function latestGlancePngPath(home) {
  return join(home, 'cache', 'glance-latest.png')
}

async function saveLatestPng(home, filePath, png, log) {
  if (!home || !png?.byteLength) return null
  try {
    await mkdir(join(home, 'cache'), { recursive: true })
    await writeFile(filePath, png)
    log?.(`chat-bridge 已落盘：${filePath}`)
    return filePath
  } catch (e) {
    log?.(`chat-bridge 落盘失败：${e?.message ?? e}`)
    return null
  }
}

export {
  GLANCE_FOLLOWUP_PREFIX,
  GLANCE_INTENT_RE,
  isGlanceIntent,
  isWatchIntent,
  parseWatchSeconds,
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
  // 文案要短：会原样出现在对话面板「用户」气泡里；长提示难翻找附图。
  return (
    `${GLANCE_FOLLOWUP_PREFIX}`
    + `（附图）主人说「${String(userText).slice(0, 40)}」。`
    + `已抓到${where} ${shot.width}×${shot.height}。`
    + '请看图用一两句口语说屏幕上有什么，说具体内容。'
    + ` ${glancePersonaBlock().replace(/\n/g, ' ')}`
  )
}

/** 中间分张：只让模型看图；对话里的短应答随后会被清掉。 */
export function followUpWatchSheetPrompt(userText, result, index, total) {
  return (
    `${GLANCE_FOLLOWUP_PREFIX}`
    + `（盯屏拼图 ${index}/${total}）主人说「${String(userText).slice(0, 40)}」。`
    + '请查看本张附图，不要回复任何文字。'
  )
}

export function followUpWatchPrompt(userText, result) {
  const silent = result?.silent ? '屏幕基本没变。' : `变化分约 ${Number(result?.maxScore || 0).toFixed(1)}。`
  const sheets = Number(result?.mosaicCount) || 1
  const delivered = Number(result?.deliveredSheets) || sheets
  const layout = `${result?.cols || '?'}×${result?.rows || '?'}`
  const sheetBit = delivered > 1
    ? `${result?.framesKept ?? 0} 帧→共 ${sheets} 张拼图，已按时间顺序分 ${delivered} 张附图（多为 2×2，${layout}）。`
    : `${result?.framesKept ?? 0} 帧→一张 ${layout} 拼图。`
  return (
    `${GLANCE_FOLLOWUP_PREFIX}`
    + `（盯屏拼图）主人说「${String(userText).slice(0, 40)}」。`
    + `盯了约 ${result?.elapsedSec ?? '?'}s，${sheetBit}`
    + silent
    + (delivered > 1
      ? '请结合全部附图，用两三句口语说这段时间发生了什么；别装眼睛酸。'
      : '请看拼图用两三句口语说发生了什么；别装眼睛酸。')
    + ` ${glancePersonaBlock().replace(/\n/g, ' ')}`
  )
}

/**
 * @param {{
 *   ctx?: object,
 *   home: string,
 *   log?: (m: string) => void,
 *   petId?: string,
 *   intervalMs?: number,
 *   getPreferredSessionId?: () => string | null,
 *   onSession?: (sessionId: string) => void,
 *   isAborted?: () => boolean,
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   prepareSession?: typeof prepareFreshRunSession,
 *   isComputerUseInstalled?: () => boolean,
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
  const recordEpisode = options.recordEpisode !== false
  const pollChat = options.pollChat !== false
  const greetOnStart = options.greetOnStart !== false
  const wake = options.wake ?? wakeSession
  const waitReply = options.waitReply ?? waitAssistantReply
  const prepareSession = options.prepareSession ?? prepareFreshRunSession
  const hasComputerUse = options.isComputerUseInstalled ?? detectComputerUse
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

  function clipBubble(text, max = 160) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (s.length <= max) return s
    return `${s.slice(0, max - 1)}…`
  }

  async function wakeObserve(userText, kind = 'observe') {
    busy = true
    const t0 = Date.now()
    try {
      try { options.onLooking?.() } catch { /* ignore */ }
      if (!hasComputerUse()) {
        await sayConclusionToPet(COMPUTER_USE_MISSING_BUBBLE, {
          pet,
          duration: 14_000,
          memoryPath: options.petMemoryPath,
        })
        await remember({
          userText,
          result: 'computer-use-missing',
          durMs: Date.now() - t0,
          error: 'missing-plugin',
        })
        return
      }

      await callDshPet('/work-status', {
        method: 'POST',
        body: { state: 'working', task: kind === 'watch' ? 'watch' : 'glance' },
      }).catch(() => {})

      await broadcastToDshPet(
        kind === 'watch'
          ? '好，我去主会话用电脑操控观察一段时间…'
          : '好，我去主会话用电脑操控看一眼屏…',
        { pet, duration: 8_000 },
      )

      const preferred = options.getPreferredSessionId?.() ?? null
      const prepared = await prepareSession(options.ctx, {
        preferredId: preferred,
        titleHint: String(userText || '').slice(0, 36) || '看屏',
        onSession: options.onSession,
        log,
      })
      if (!prepared.sessionId) {
        await sayConclusionToPet(
          '我开不出主会话来看屏。请先在 Harness 里打开一个对话，再说一遍。',
          { pet, duration: 12_000, memoryPath: options.petMemoryPath },
        )
        return
      }

      const prompt = buildComputerUseObservePrompt(
        kind === 'watch'
          ? `${userText}（请多观察一会儿变化，用 wait_for/screenshot/ocr 核对）`
          : userText,
      )
      const woken = await wake(options.ctx, {
        text: prompt,
        sessionId: prepared.sessionId,
        preferredId: prepared.sessionId,
      })
      if (!woken.ok) {
        await sayConclusionToPet(
          `没叫醒主会话看屏（${woken.reason || 'unknown'}）。`,
          { pet, duration: 12_000, memoryPath: options.petMemoryPath },
        )
        await remember({
          userText,
          result: 'wake-failed',
          durMs: Date.now() - t0,
          error: woken.reason || 'wake-failed',
        })
        return
      }
      try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
      const reply = await waitReply(options.ctx, woken.sessionId, {
        timeoutMs: kind === 'watch' ? 240_000 : 120_000,
        isAborted: () => stopped || Boolean(options.isAborted?.()),
      })
      if (reply.ok && reply.text) {
        await sayConclusionToPet(clipBubble(reply.text), {
          pet,
          duration: 14_000,
          memoryPath: options.petMemoryPath,
        })
        await remember({
          userText,
          result: 'ok',
          durMs: Date.now() - t0,
          reply: reply.text,
        })
      } else {
        const fail = reply.reason === 'timeout'
          ? '主会话看屏超时了，去会话里看看进度，或再说一遍。'
          : '主会话这轮没给出看屏结论。'
        await sayConclusionToPet(fail, {
          pet,
          duration: 12_000,
          memoryPath: options.petMemoryPath,
        })
        await remember({
          userText,
          result: reply.reason || 'no-reply',
          durMs: Date.now() - t0,
          error: reply.reason || 'empty',
        })
      }
    } finally {
      await callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})
      try { options.onIdle?.() } catch { /* ignore */ }
      busy = false
    }
  }

  async function handleWatchIntent(userText) {
    await wakeObserve(userText, 'watch')
  }

  async function handleIntent(userText) {
    if (isWatchIntent(userText)) {
      await handleWatchIntent(userText)
      return
    }
    await wakeObserve(userText, 'observe')
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
      '小蓝鲸已接入：可以闲聊；看屏/干活走电脑操控；也可教我或跑脚本。',
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
