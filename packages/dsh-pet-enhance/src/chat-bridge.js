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
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFrame } from './capture.js'
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
import { runWatch } from './watch-loop.js'
import { sayConclusionToPet, stripTrailingShortAcks } from './pet-chat-memory.js'

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

  async function tryChatWithPng(prompt, png) {
    return chatWithDshPet(prompt, {
      pet,
      attachment: {
        mediaType: 'image/png',
        data: png.toString('base64'),
      },
      timeoutMs: 120_000,
    })
  }

  /**
   * dsh-pet /chat 一次只能附一张图：多张 sheet 按时间顺序分多次送进对话与模型。
   */
  async function deliverWatchSheets(userText, shot, t0) {
    const pngs = (Array.isArray(shot.pngs) ? shot.pngs : [])
      .filter((b) => Buffer.isBuffer(b) && b.byteLength > 0)
    if (!pngs.length && Buffer.isBuffer(shot.png) && shot.png.byteLength > 0) {
      pngs.push(shot.png)
    }
    if (!pngs.length) {
      await sayConclusionToPet('盯完了，但图数据坏了。', {
        pet,
        memoryPath: options.petMemoryPath,
      })
      await remember({
        userText,
        shot,
        result: 'bad-png',
        durMs: Date.now() - t0,
        error: 'bad-png',
      })
      return
    }

    const total = pngs.length
    let lastReply = ''
    let lastPrompt = ''
    let okCount = 0
    let lastError = ''

    for (let i = 0; i < total; i += 1) {
      const isLast = i === total - 1
      const prompt = isLast
        ? followUpWatchPrompt(userText, { ...shot, deliveredSheets: total })
        : followUpWatchSheetPrompt(userText, shot, i + 1, total)
      const chat = await tryChatWithPng(prompt, pngs[i])
      if (!chat.ok || chat.data?.ok === false) {
        lastError = chat.data?.reason || chat.error || `http-${chat.status}`
        log(`chat-bridge 盯屏分张 ${i + 1}/${total} 失败：${lastError}`)
        if (!isLast) continue
        break
      }
      okCount += 1
      lastPrompt = prompt
      lastReply = typeof chat.data?.text === 'string' ? chat.data.text : ''
      lastContent = prompt
      lastTs = Date.now()
      // 中间张：模型已看过图；清掉「嗯/好」短回复，聊天里只留图
      if (!isLast) {
        const stripped = await stripTrailingShortAcks(pet).catch(() => null)
        if (stripped?.removed) {
          log(`chat-bridge 已去掉 ${stripped.removed} 条短应答`)
        }
      }
      log(`chat-bridge 盯屏分张 ${i + 1}/${total} 已送进对话`)
    }

    if (okCount === 0) {
      const fallback = (
        `盯完了约 ${shot.elapsedSec ?? '?'}s，留 ${shot.framesKept ?? 0} 帧，`
        + `共 ${shot.mosaicCount || total} 张拼图。`
        + `附图对话失败（${lastError || 'unknown'}）；请打开 cache/watch-latest.png 看。`
      )
      await sayConclusionToPet(fallback, {
        pet,
        duration: 18_000,
        memoryPath: options.petMemoryPath,
      })
      await remember({
        userText,
        shot,
        result: 'chat-failed',
        durMs: Date.now() - t0,
        error: lastError || 'all-sheets-failed',
        reply: fallback,
      })
      return
    }

    await remember({
      userText,
      shot,
      result: 'ok',
      durMs: Date.now() - t0,
      reply: lastReply || lastPrompt,
    })
  }

  async function deliverShot(userText, shot, t0, promptBuilder = followUpPrompt) {
    if (!shot?.png || !Buffer.isBuffer(shot.png)) {
      await sayConclusionToPet('抓到了，但图数据坏了。', {
        pet,
        memoryPath: options.petMemoryPath,
      })
      await remember({
        userText,
        shot,
        result: 'bad-png',
        durMs: Date.now() - t0,
        error: 'bad-png',
      })
      return
    }

    const prompt = promptBuilder(userText, shot)
    const chat = await tryChatWithPng(prompt, shot.png)

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
      const fallback = (
        `我看了一眼：${where} → ${shot.width}×${shot.height}`
        + `（${shot.quality} · ${shot.engine} · ${shot.ms}ms）。`
      )
      await sayConclusionToPet(fallback, {
        pet,
        duration: 14_000,
        memoryPath: options.petMemoryPath,
      })
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
  }

  async function handleWatchIntent(userText) {
    const seconds = parseWatchSeconds(userText, 60)
    busy = true
    const t0 = Date.now()
    try {
      try { options.onLooking?.() } catch { /* ignore */ }
      await callDshPet('/work-status', {
        method: 'POST',
        body: { state: 'working', task: 'watch' },
      }).catch(() => {})

      const notice = await broadcastToDshPet(
        `好，我最多盯大约 ${seconds} 秒（有变化就留帧，优先凑满 4 帧拼成 2×2）；盯完把拼图给你。`,
        { pet, duration: Math.min(12_000, seconds * 200) },
      )
      if (!notice.ok || notice.data?.ok === false) {
        log(`chat-bridge watch 预告失败：${notice.error || notice.data?.reason || notice.status}`)
      }

      const sidecar = typeof options.sidecar === 'function'
        ? options.sidecar()
        : options.sidecar
      let result
      try {
        result = await runWatch({
          home: options.home,
          sidecar,
          quality: 'low',
          seconds,
          log,
        })
      } catch (e) {
        const msg = `盯屏没看成：${e?.message ?? e}`
        log(`chat-bridge watch 失败：${msg}`)
        await sayConclusionToPet(msg, {
          pet,
          duration: 12_000,
          memoryPath: options.petMemoryPath,
        })
        await remember({
          userText,
          result: 'watch-failed',
          durMs: Date.now() - t0,
          error: e?.message ?? String(e),
        })
        return
      }

      const saved = await saveLatestPng(
        options.home,
        latestWatchPngPath(options.home),
        result.png,
        log,
      )
      // 分张落盘，方便最近聊天/本地翻看
      const sheetPngs = Array.isArray(result.pngs) ? result.pngs : []
      for (let i = 0; i < sheetPngs.length; i += 1) {
        const name = i === 0 ? 'watch-latest.png' : `watch-latest-${i + 1}.png`
        await saveLatestPng(
          options.home,
          join(options.home, 'cache', name),
          sheetPngs[i],
          log,
        ).catch(() => {})
      }

      const sheetN = result.mosaicCount || sheetPngs.length || 1
      const deliverPngs = Array.isArray(result.deliverPngs) && result.deliverPngs.length
        ? result.deliverPngs
        : sheetPngs.slice(-Math.max(1, result.deliveredSheets || sheetN))
      const delivered = deliverPngs.length
      const skipBit = result.skippedSheets > 0
        ? `（共 ${sheetN} 张，对话分张送最近 ${delivered} 张；其余在 cache/watch-latest-*.png）`
        : (delivered > 1 ? `（将分 ${delivered} 张依次送进对话）` : '')
      await broadcastToDshPet(
        (result.silent
          ? `盯完了：约 ${result.elapsedSec}s，屏幕基本没变（${result.framesKept} 帧 / ${sheetN} 张拼图）。`
          : `盯完了：约 ${result.elapsedSec}s，留了 ${result.framesKept} 帧，拼成 ${sheetN} 张（${result.cols || '?'}×${result.rows || '?'}）。`)
        + skipBit
        + (saved
          ? ' 拼图马上分张送到对话面板（请滚到底）。'
          : ' 拼图马上分张送到对话面板，请滚到底看。'),
        { pet, duration: 16_000 },
      )

      const shot = {
        png: deliverPngs[deliverPngs.length - 1] || result.png,
        pngs: deliverPngs,
        width: result.width,
        height: result.height,
        quality: result.quality,
        engine: 'watch',
        ms: Date.now() - t0,
        silent: result.silent,
        elapsedSec: result.elapsedSec,
        framesKept: result.framesKept,
        mosaicCount: sheetN,
        deliveredSheets: delivered,
        skippedSheets: result.skippedSheets || 0,
        tokens: result.tokens,
        maxScore: result.maxScore,
        cols: result.cols,
        rows: result.rows,
      }
      await deliverWatchSheets(userText, shot, t0)
    } finally {
      await callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})
      try { options.onIdle?.() } catch { /* ignore */ }
      busy = false
    }
  }

  async function handleIntent(userText) {
    if (isWatchIntent(userText)) {
      await handleWatchIntent(userText)
      return
    }

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
        await sayConclusionToPet(msg, {
          pet,
          duration: 12_000,
          memoryPath: options.petMemoryPath,
        })
        await remember({
          userText,
          result: 'capture-failed',
          durMs: Date.now() - t0,
          error: e?.message ?? String(e),
        })
        return
      }

      await saveLatestPng(options.home, latestGlancePngPath(options.home), shot.png, log)
      await deliverShot(userText, shot, t0, followUpPrompt)
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
      '小蓝鲸已接入：闲聊已关。要看屏幕、教我操作、或让我动手，直接说就行。',
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
