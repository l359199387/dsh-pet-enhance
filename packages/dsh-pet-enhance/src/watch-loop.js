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
  maxFrames: 8,
  sampleMs: 1000,
  maxAutonomousWakes: 8,
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
  const targetFrames = clampInt(options.frames, 1, WATCH_DEFAULTS.maxFrames, WATCH_DEFAULTS.frames)
  const sampleMs = clampInt(options.sampleMs, 200, 5_000, WATCH_DEFAULTS.sampleMs)
  const log = options.log ?? (() => {})
  const signal = options.signal
  const sidecar = options.sidecar

  if (!sidecar || typeof sidecar.call !== 'function') {
    throw Object.assign(new Error('watch 需要 Python sidecar'), { code: 'SIDECAR_DOWN' })
  }

  // 重置流式打分，避免跨次 watch 污染
  try {
    await sidecar.call('diff', { reset: true }, 5_000)
  } catch { /* ignore */ }

  const selector = createFrameSelector({ fps: Math.max(0.5, 1000 / sampleMs) })
  const started = Date.now()
  const deadline = started + seconds * 1000
  /** @type {{ png: Buffer, label: string, score: number, reason: string, t: number }[]} */
  const kept = []
  let samples = 0
  let maxScore = 0
  let lastScore = 0

  selector.reset(0)

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
      const label = `${kept.length + 1}  +${tRel.toFixed(1)}s`
      kept.push({
        png: shot.png,
        label,
        score: score ?? 0,
        reason: decision.reason || 'first',
        t: tRel,
      })
      log(`watch 留帧 #${kept.length} reason=${decision.reason} score=${(score ?? 0).toFixed(2)}`)
      if (kept.length >= targetFrames) break
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

  const resp = await sidecar.call('mosaic', {
    quality,
    frames: kept.map((f) => ({
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
  const mosaicW = Number(resp.w)
  const mosaicH = Number(resp.h)
  const cols = Number(resp.cols) || 1
  const rows = Number(resp.rows) || 1

  const expected = CANVAS_BY_QUALITY[quality] || CANVAS_BY_QUALITY.low
  const tokens = imageTokens(mosaicW || expected.w, mosaicH || expected.h)
  const elapsedSec = Math.round((Date.now() - started) / 1000)

  return {
    png: mosaicPng,
    width: mosaicW || expected.w,
    height: mosaicH || expected.h,
    quality,
    tokens,
    expectedTokens: expected.tokens,
    cols,
    rows,
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
