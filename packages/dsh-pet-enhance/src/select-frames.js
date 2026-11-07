/**
 * 选帧：切点 + 积分 + 静止兜底。
 * 只吃「变化分」数字，不碰像素。
 *
 * @module src/select-frames.js
 */

/** 中等强度画面每帧参考分（0–255 刻度）。 */
export const REF_SCORE = 4

export const SELECT_DEFAULTS = Object.freeze({
  /** 硬切绝对门槛 */
  cutAbs: 12,
  /** 两帧最小间隔（秒） */
  markMinGap: 0.5,
  /** 积分：中等运动攒够这么多秒出一帧 */
  integralSeconds: 3,
  /** 采样假设 fps（桌面陪看约 1） */
  fps: 1,
  /** 完全静止兜底 */
  silentFloorSec: 20,
  /** 与上一张留下的帧差太小则丢 */
  dupMin: 8,
})

/**
 * @param {Partial<typeof SELECT_DEFAULTS>} [opts]
 */
export function createFrameSelector(opts = {}) {
  const o = { ...SELECT_DEFAULTS, ...opts }
  const need = REF_SCORE * o.fps * o.integralSeconds

  let integral = 0
  let lastKeepAt = -Infinity
  let lastKeepScore = Infinity
  let startedAt = 0
  let kept = 0

  function reset(now = 0) {
    integral = 0
    lastKeepAt = -Infinity
    lastKeepScore = Infinity
    startedAt = now
    kept = 0
  }

  /**
   * @param {{ score: number | null, t: number, isFirst?: boolean }} input
   * @returns {{ keep: boolean, reason: 'first' | 'cut' | 'integral' | 'floor' | null }}
   */
  function push({ score, t, isFirst = false }) {
    if (!Number.isFinite(startedAt) || startedAt === 0) startedAt = t

    if (isFirst || score == null) {
      lastKeepAt = t
      lastKeepScore = 0
      kept += 1
      integral = 0
      return { keep: true, reason: 'first' }
    }

    const s = Number(score) || 0
    const gap = t - lastKeepAt

    // 硬切：单帧变化够大；过小变化当噪声（dupMin）
    if (s >= o.cutAbs && gap >= o.markMinGap && s >= o.dupMin) {
      lastKeepAt = t
      lastKeepScore = s
      kept += 1
      integral = 0
      return { keep: true, reason: 'cut' }
    }

    // 积分：累加够了就留（当前帧分可以低于 cutAbs，这是连续运动的意义）
    integral += s
    if (integral >= need && gap >= o.markMinGap) {
      lastKeepAt = t
      lastKeepScore = s
      kept += 1
      integral = 0
      return { keep: true, reason: 'integral' }
    }

    // 静止兜底
    if (gap >= o.silentFloorSec) {
      lastKeepAt = t
      lastKeepScore = s
      kept += 1
      integral = 0
      return { keep: true, reason: 'floor' }
    }

    return { keep: false, reason: null }
  }

  function status() {
    return {
      kept,
      integral,
      need,
      lastKeepAt,
      silentFloorSec: o.silentFloorSec,
      cutAbs: o.cutAbs,
    }
  }

  return { reset, push, status, need }
}
