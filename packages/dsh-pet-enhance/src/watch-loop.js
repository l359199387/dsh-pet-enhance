/**
 * `glance({action:"watch"})`：阻塞盯屏 → 变化分选帧 → 拼图返回。
 * 不向会话推图；只作为工具返回值（硬约束）。
 *
 * @module src/watch-loop.js
 */

import { captureFrame, normalizeQuality, canvasWidth } from './capture.js'
import { createFrameSelector } from './select-frames.js'
import { CANVAS_BY_QUALITY, imageTokens } from './image-tokens.js'

export const WATCH_DEFAULTS = Object.freeze({
  seconds: 60,
  maxSeconds: 600,
  frames: 4,
  maxFrames: 12,
  sampleMs: 1000,
  maxAutonomousWakes: 8,
})

/** 对齐 dsh-see-now：每张 sheet 最多 2×2（4 格），多了拆成多张。 */
export const MOSAIC_FRAMES_PER_SHEET = 4

/** 按每张 sheet 格数切开（默认 4）。 */
export function chunkFrames(items, size = MOSAIC_FRAMES_PER_SHEET) {
  const n = Math.max(1, Math.trunc(Number(size) || MOSAIC_FRAMES_PER_SHEET))
  const out = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

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

/** 按时长给「最多留几帧」：约每 3 秒一格，2–12（30 秒约 10 格）。 */
export function watchFrameBudget(seconds) {
  const s = clampInt(seconds, 1, WATCH_DEFAULTS.maxSeconds, WATCH_DEFAULTS.seconds)
  return Math.min(WATCH_DEFAULTS.maxFrames, Math.max(2, Math.ceil(s / 3)))
}

/** 静止兜底间隔：短盯密一点，长盯最多 20s。 */
export function watchSilentFloorSec(seconds) {
  const s = clampInt(seconds, 1, WATCH_DEFAULTS.maxSeconds, WATCH_DEFAULTS.seconds)
  return Math.min(20, Math.max(6, Math.round(s / 4)))
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
 *   frames?: number,
 *   signal?: AbortSignal,
 *   sampleMs?: number,
 *   log?: (m: string) => void,
 * }} options
 */
export async function runWatch(options = {}) {
  const quality = normalizeQuality(options.quality)
  const seconds = clampInt(options.seconds, 1, WATCH_DEFAULTS.maxSeconds, WATCH_DEFAULTS.seconds)
  const targetFrames = clampInt(
    options.frames ?? watchFrameBudget(seconds),
    1,
    WATCH_DEFAULTS.maxFrames,
    watchFrameBudget(seconds),
  )
  const sampleMs = clampInt(options.sampleMs, 200, 5_000, WATCH_DEFAULTS.sampleMs)
  const silentFloorSec = clampInt(
    options.silentFloorSec ?? watchSilentFloorSec(seconds),
    5,
    60,
    watchSilentFloorSec(seconds),
  )
  const log = options.log ?? (() => {})
  const signal = options.signal
  const sidecar = options.sidecar
  // 用户说了盯 N 秒就盯满；frames 只是「最多留几格」，不能凑满就提前收工
  const earlyStop = options.earlyStop === true

  if (!sidecar || typeof sidecar.call !== 'function') {
    throw Object.assign(new Error('watch 需要 Python sidecar'), { code: 'SIDECAR_DOWN' })
  }

  // 重置流式打分，避免跨次 watch 污染
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
  const kept = []
  let samples = 0
  let maxScore = 0
  let lastScore = 0

  selector.reset(0)
  log(`watch 开始：${seconds}s · 最多 ${targetFrames} 帧 · 静止兜底 ${silentFloorSec}s`)

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw Object.assign(new Error('watch 被取消'), { code: 'ABORTED' })
    }

    const tRel = (Date.now() - started) / 1000
    let shot
    try {
      // 直接走 sidecar capture 拿 score；仍经 captureFrame 统一降级语义（窗口必须 sidecar）
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
      // 无窗口匹配等硬错误立刻抛；偶发超时继续
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
      if (kept.length < targetFrames) {
        const label = `${kept.length + 1}  +${tRel.toFixed(1)}s`
        kept.push({
          png: shot.png,
          label,
          score: score ?? 0,
          reason: decision.reason || 'first',
          t: tRel,
        })
        log(`watch 留帧 #${kept.length} reason=${decision.reason} score=${(score ?? 0).toFixed(2)}`)
      }
      // 仅显式 earlyStop 时才「帧满提前收工」；默认盯满用户说的秒数
      if (earlyStop && kept.length >= targetFrames) break
    }

    const remain = deadline - Date.now()
    if (remain <= 0) break
    await sleep(Math.min(sampleMs, remain), signal)
  }

  // 超时仍无帧：强制抓一张兜底
  if (kept.length === 0) {
    const shot = await captureFrame({
      sidecar,
      quality,
      window: options.window,
      region: options.region,
      home: options.home,
      signal,
    })
    kept.push({
      png: shot.png,
      label: '1  +0.0s',
      score: 0,
      reason: 'floor',
      t: 0,
    })
  }

  const silent = maxScore < 2 && kept.every((f) => f.reason === 'first' || f.reason === 'floor')

  // see-now 口径：每张最多 2×2；10 格 → 3 张（4+4+2），单格保持清晰
  const sheets = chunkFrames(kept, MOSAIC_FRAMES_PER_SHEET)
  /** @type {{ png: Buffer, width: number, height: number, cols: number, rows: number, tokens: number, frameCount: number, labels: string[] }[]} */
  const mosaics = []
  for (let si = 0; si < sheets.length; si += 1) {
    const sheet = sheets[si]
    const resp = await sidecar.call('mosaic', {
      quality,
      frames: sheet.map((f) => ({
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
      frameCount: sheet.length,
      labels: sheet.map((f) => f.label),
    })
    log(`watch 拼图 ${si + 1}/${sheets.length}：${sheet.length} 帧 → ${mosaicW}×${mosaicH}`)
  }

  const expected = CANVAS_BY_QUALITY[quality] || CANVAS_BY_QUALITY.low
  let deliverPng = mosaics[0]?.png
  let deliverW = mosaics[0]?.width || expected.w
  let deliverH = mosaics[0]?.height || expected.h
  // 多张时竖向叠成一张交给「单附件」对话路径；单格仍是完整 2×2 清晰度
  if (mosaics.length > 1) {
    try {
      const stacked = await sidecar.call('stack', {
        pngs: mosaics.map((m) => m.png.toString('base64')),
        gap: 8,
      }, 30_000)
      if (stacked?.ok && stacked.png) {
        deliverPng = Buffer.from(String(stacked.png), 'base64')
        deliverW = Number(stacked.w) || deliverW
        deliverH = Number(stacked.h) || deliverH
      }
    } catch (e) {
      log(`watch 叠图失败，回退首张：${e?.message ?? e}`)
    }
  }

  const tokens = mosaics.reduce((sum, m) => sum + (m.tokens || 0), 0)
  const elapsedSec = Math.round((Date.now() - started) / 1000)

  return {
    png: deliverPng,
    pngs: mosaics.map((m) => m.png),
    mosaics,
    mosaicCount: mosaics.length,
    width: deliverW,
    height: deliverH,
    quality,
    tokens,
    expectedTokens: expected.tokens * mosaics.length,
    cols: mosaics[0]?.cols || 1,
    rows: mosaics[0]?.rows || 1,
    framesKept: kept.length,
    samples,
    maxScore,
    lastScore,
    silent,
    elapsedSec,
    reasons: kept.map((f) => f.reason),
    labels: kept.map((f) => f.label),
  }
}
