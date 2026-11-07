/**
 * `glance({action:"watch"})`：阻塞盯屏 → 变化分选帧 → 按 see-now 节奏封成 sheet。
 * 对齐 @_ref/dsh-see-now：变化驱动留帧；prefer≈2 / cap=4 / maxWait 封箱；
 * 拼图 cover 填格消黑边；布局按源比例自适应（横屏 2→1×2）；静止约 20s 兜底。
 *
 * @module src/watch-loop.js
 */

import { captureFrame, normalizeQuality, canvasWidth } from './capture.js'
import { createFrameSelector, SELECT_DEFAULTS } from './select-frames.js'
import { CANVAS_BY_QUALITY, imageTokens } from './image-tokens.js'

export const WATCH_DEFAULTS = Object.freeze({
  seconds: 60,
  maxSeconds: 600,
  sampleMs: 1000,
  maxAutonomousWakes: 8,
  /** 管道内总留帧上限（see-now pipeline maxFrames 量级） */
  maxFrames: 40,
  /**
   * 交给对话 / 模型的最多几张 sheet（分张送，不再竖向叠图）。
   * 超出部分仍落盘为 watch-latest-*.png，只是不进对话以免刷屏与爆 token。
   */
  maxDeliverSheets: 6,
})

/** 与 see-now region 封箱对齐 */
export const SHEET_DEFAULTS = Object.freeze({
  preferFrames: 2,
  maxFramesPerSheet: 4,
  maxWaitSec: 15,
  silentFloorSec: SELECT_DEFAULTS.silentFloorSec, // 20
})

/**
 * 连续无人回应的 watch 叫醒预算（进程内）。
 * 用户新消息应调用 `noteUserTurn()` 清零。
 */
export function createWakeBudget(max = WATCH_DEFAULTS.maxAutonomousWakes) {
  let wakes = 0
  let stopped = false
  let stopReason = ''

  return {
    /** @returns {{ ok: boolean, wakes: number, max: number, reason?: string }} */
    beginWatch() {
      if (stopped) {
        return {
          ok: false,
          wakes,
          max,
          reason: stopReason || `连续 ${max} 次叫醒无人回应，已自动停 watch。请新开一轮对话再试。`,
        }
      }
      wakes += 1
      if (wakes > max) {
        stopped = true
        stopReason = `连续 ${max} 次叫醒无人回应，已自动停 watch。请新开一轮对话再试。`
        return { ok: false, wakes, max, reason: stopReason }
      }
      return { ok: true, wakes, max }
    },
    noteUserTurn() {
      wakes = 0
      stopped = false
      stopReason = ''
    },
    status() {
      return { wakes, max, stopped, reason: stopReason || null }
    },
    reset() {
      wakes = 0
      stopped = false
      stopReason = ''
    },
  }
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/**
 * see-now region 风格封箱判定。
 * @param {{ length: number, sheetAgeSec: number, preferFrames?: number, maxFramesPerSheet?: number, maxWaitSec?: number }} p
 * @returns {'cap'|'prefer'|'time'|null}
 */
export function decideSheetFlush(p) {
  const n = Math.max(0, Number(p.length) || 0)
  if (n <= 0) return null
  const prefer = Math.max(1, Number(p.preferFrames) || SHEET_DEFAULTS.preferFrames)
  const cap = Math.max(prefer, Number(p.maxFramesPerSheet) || SHEET_DEFAULTS.maxFramesPerSheet)
  const maxWait = Math.max(1, Number(p.maxWaitSec) || SHEET_DEFAULTS.maxWaitSec)
  const age = Math.max(0, Number(p.sheetAgeSec) || 0)

  if (n >= cap) return 'cap'
  if (n >= prefer) return 'prefer'
  // 单帧：等满 min(30, 2×maxWait) 再发（see-now region：避免每 15s 扔一张单帧）
  const singleWait = Math.min(30, maxWait * 2)
  if (n === 1 && age >= singleWait) return 'time'
  return null
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('watch 被取消'), { code: 'ABORTED' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('watch 被取消'), { code: 'ABORTED' }))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * @param {{
 *   home: string,
 *   sidecar?: { call: Function, isAlive?: Function } | null,
 *   quality?: string,
 *   window?: string,
 *   region?: string | object,
 *   seconds?: number,
 *   preferFrames?: number,
 *   maxFramesPerSheet?: number,
 *   maxWaitSec?: number,
 *   silentFloorSec?: number,
 *   signal?: AbortSignal,
 *   sampleMs?: number,
 *   log?: (m: string) => void,
 * }} options
 */
export async function runWatch(options = {}) {
  const quality = normalizeQuality(options.quality)
  // seconds = 阻塞上限（see-now）；画面够了会中途封多张 sheet，不是「必须凑满 N 格」
  const seconds = clampInt(options.seconds, 1, WATCH_DEFAULTS.maxSeconds, WATCH_DEFAULTS.seconds)
  const sampleMs = clampInt(options.sampleMs, 200, 5_000, WATCH_DEFAULTS.sampleMs)
  const preferFrames = clampInt(options.preferFrames, 1, 4, SHEET_DEFAULTS.preferFrames)
  const maxFramesPerSheet = clampInt(
    options.maxFramesPerSheet,
    preferFrames,
    4,
    SHEET_DEFAULTS.maxFramesPerSheet,
  )
  const maxWaitSec = clampInt(options.maxWaitSec, 5, 120, SHEET_DEFAULTS.maxWaitSec)
  const silentFloorSec = clampInt(
    options.silentFloorSec,
    5,
    60,
    SHEET_DEFAULTS.silentFloorSec,
  )
  const maxTotalFrames = clampInt(options.maxFrames, 1, 80, WATCH_DEFAULTS.maxFrames)
  const log = options.log ?? (() => {})
  const signal = options.signal
  const sidecar = options.sidecar

  if (!sidecar || typeof sidecar.call !== 'function') {
    throw Object.assign(new Error('watch 需要 Python sidecar'), { code: 'SIDECAR_DOWN' })
  }

  try {
    await sidecar.call('diff', { reset: true }, 5_000)
  } catch { /* ignore */ }

  const selector = createFrameSelector({
    fps: Math.max(0.5, 1000 / sampleMs),
    silentFloorSec,
  })
  const started = Date.now()
  const deadline = started + seconds * 1000

  /** @type {{ png: Buffer, label: string, score: number, reason: string, t: number }[]} */
  let sheet = []
  let sheetStart = 0
  let globalKeep = 0
  let samples = 0
  let maxScore = 0
  let lastScore = 0
  /** @type {{ png: Buffer, width: number, height: number, cols: number, rows: number, tokens: number, frameCount: number, labels: string[], why: string }[]} */
  const mosaics = []
  /** @type {string[]} */
  const allReasons = []
  /** @type {string[]} */
  const allLabels = []

  selector.reset(0)
  log(
    `watch 开始（see-now 节奏）：上限 ${seconds}s · prefer=${preferFrames}`
    + ` · cap=${maxFramesPerSheet} · maxWait=${maxWaitSec}s · floor=${silentFloorSec}s`,
  )

  async function composeSheet(frames, why) {
    if (!frames.length) return
    const resp = await sidecar.call('mosaic', {
      quality,
      frames: frames.map((f) => ({
        png: f.png.toString('base64'),
        label: f.label,
      })),
    }, 30_000)
    if (!resp?.ok) {
      throw Object.assign(new Error(resp?.error?.message || '拼图失败'), {
        code: resp?.error?.code || 'MOSAIC_FAILED',
      })
    }
    const mosaicPng = Buffer.from(String(resp.png || ''), 'base64')
    const mosaicW = Number(resp.w) || 0
    const mosaicH = Number(resp.h) || 0
    mosaics.push({
      png: mosaicPng,
      width: mosaicW,
      height: mosaicH,
      cols: Number(resp.cols) || 1,
      rows: Number(resp.rows) || 1,
      tokens: imageTokens(mosaicW, mosaicH),
      frameCount: frames.length,
      labels: frames.map((f) => f.label),
      why,
    })
    log(
      `watch 封箱 #${mosaics.length} why=${why}：${frames.length} 帧`
      + ` → ${resp.cols}×${resp.rows} ${mosaicW}×${mosaicH}`,
    )
  }

  async function flushSheet(why) {
    if (!sheet.length) return
    const batch = sheet
    sheet = []
    sheetStart = 0
    await composeSheet(batch, why)
  }

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw Object.assign(new Error('watch 被取消'), { code: 'ABORTED' })
    }
    if (globalKeep >= maxTotalFrames) {
      await flushSheet('cap-total')
      break
    }

    const tRel = (Date.now() - started) / 1000
    let shot
    try {
      const resp = await sidecar.call(
        'capture',
        {
          source: options.window
            ? { kind: 'window', match: String(options.window) }
            : options.region
              ? { kind: 'screen', region: options.region }
              : { kind: 'screen' },
          max_width: canvasWidth(quality),
          score: true,
          mask: true,
        },
        30_000,
      )
      if (!resp?.ok) {
        const err = resp?.error ?? {}
        throw Object.assign(new Error(err.message || '抓屏失败'), {
          code: err.code || 'CAPTURE_FAILED',
          candidates: err.candidates,
        })
      }
      shot = {
        png: Buffer.from(String(resp.png || ''), 'base64'),
        width: Number(resp.w) || 0,
        height: Number(resp.h) || 0,
        score: Number(resp.score) || 0,
        scoreReady: Boolean(resp.scoreReady),
        masked: Array.isArray(resp.masked) ? resp.masked : [],
        window: resp.window ?? null,
        active: resp.active ?? null,
        ms: Number(resp.ms) || 0,
      }
    } catch (e) {
      if (['WINDOW_NOT_FOUND', 'WINDOW_AMBIGUOUS', 'BAD_REQUEST', 'ABORTED'].includes(e?.code)) {
        throw e
      }
      log(`watch 采样失败：${e?.message ?? e}`)
      await sleep(sampleMs, signal)
      continue
    }

    samples += 1
    const isFirst = !shot.scoreReady
    const score = isFirst ? null : shot.score
    if (typeof score === 'number') {
      lastScore = score
      if (score > maxScore) maxScore = score
    }

    const decision = selector.push({ score, t: tRel, isFirst })
    if (decision.keep) {
      if (sheet.length === 0) sheetStart = tRel
      globalKeep += 1
      const label = `${globalKeep}  +${tRel.toFixed(1)}s`
      const entry = {
        png: shot.png,
        label,
        score: score ?? 0,
        reason: decision.reason || 'first',
        t: tRel,
      }
      sheet.push(entry)
      allReasons.push(entry.reason)
      allLabels.push(label)
      log(`watch 留帧 #${globalKeep} reason=${entry.reason} score=${entry.score.toFixed(2)}`)

      const why = decideSheetFlush({
        length: sheet.length,
        sheetAgeSec: tRel - sheetStart,
        preferFrames,
        maxFramesPerSheet,
        maxWaitSec,
      })
      if (why) await flushSheet(why)
    } else if (sheet.length > 0) {
      // 无新留帧时也要看时间出口（单帧等太久）
      const why = decideSheetFlush({
        length: sheet.length,
        sheetAgeSec: tRel - sheetStart,
        preferFrames,
        maxFramesPerSheet,
        maxWaitSec,
      })
      if (why === 'time') await flushSheet(why)
    }

    const remain = deadline - Date.now()
    if (remain <= 0) break
    await sleep(Math.min(sampleMs, remain), signal)
  }

  // 收尾：未封箱的尾巴
  if (sheet.length) await flushSheet('end')

  // 全程无帧：强制一张兜底
  if (!mosaics.length) {
    const shot = await captureFrame({
      sidecar,
      quality,
      window: options.window,
      region: options.region,
      home: options.home,
      signal,
    })
    await composeSheet([{
      png: shot.png,
      label: '1  +0.0s',
      score: 0,
      reason: 'floor',
      t: 0,
    }], 'force')
    allReasons.push('floor')
    allLabels.push('1  +0.0s')
    globalKeep = 1
  }

  const silent = maxScore < 2 && allReasons.every((r) => r === 'first' || r === 'floor')
  const expected = CANVAS_BY_QUALITY[quality] || CANVAS_BY_QUALITY.low
  const maxDeliver = clampInt(
    options.maxDeliverSheets,
    1,
    8,
    WATCH_DEFAULTS.maxDeliverSheets,
  )
  // 分张交付（不叠图）：对话 / 模型各收一张；磁盘仍保留全部 sheet
  const deliverSheets = mosaics.slice(-maxDeliver)
  const skippedSheets = Math.max(0, mosaics.length - deliverSheets.length)
  const lastSheet = deliverSheets[deliverSheets.length - 1] || mosaics[0]

  if (skippedSheets > 0) {
    log(`watch 交付裁切：共 ${mosaics.length} 张 sheet，对话分张附最近 ${deliverSheets.length} 张`)
  }

  const tokens = deliverSheets.reduce((sum, m) => sum + (m.tokens || 0), 0)
  const elapsedSec = Math.round((Date.now() - started) / 1000)

  return {
    /** 兼容旧调用方：默认等于最后一张 sheet */
    png: lastSheet?.png,
    /** 全部分张（含未送进对话的） */
    pngs: mosaics.map((m) => m.png),
    /** 将送进对话 / 模型的分张（时间序） */
    deliverPngs: deliverSheets.map((m) => m.png),
    mosaics,
    mosaicCount: mosaics.length,
    deliveredSheets: deliverSheets.length,
    skippedSheets,
    width: lastSheet?.width || expected.w,
    height: lastSheet?.height || expected.h,
    quality,
    tokens,
    expectedTokens: expected.tokens * deliverSheets.length,
    cols: lastSheet?.cols || 1,
    rows: lastSheet?.rows || 1,
    framesKept: globalKeep,
    samples,
    maxScore,
    lastScore,
    silent,
    elapsedSec,
    reasons: allReasons,
    labels: allLabels,
  }
}
