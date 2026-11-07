/**
 * 变化分：64×36 HSV 加权差（0–255）。
 *
 * 生产路径走 sidecar `diff` / `capture({score:true})`（Python/Pillow）。
 * 本文件保留同口径纯 JS，供单测与无 sidecar 时的离线推演。
 *
 * @module src/change-score.js
 */

export const SCAN_W = 64
export const SCAN_H = 36

/**
 * @param {Float32Array | number[]} rgb  length SCAN_W*SCAN_H*3
 * @param {Float32Array | number[]} [out]
 */
export function rgbToHsv(rgb, out = new Float32Array(rgb.length)) {
  for (let i = 0; i < rgb.length; i += 3) {
    const rn = rgb[i] / 255
    const gn = rgb[i + 1] / 255
    const bn = rgb[i + 2] / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const d = max - min
    let h = 0
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6
      else if (max === gn) h = (bn - rn) / d + 2
      else h = (rn - gn) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    out[i] = (h / 360) * 255
    out[i + 1] = max === 0 ? 0 : (d / max) * 255
    out[i + 2] = max * 255
  }
  return out
}

/**
 * @param {Float32Array | number[]} prev
 * @param {Float32Array | number[]} cur
 * @returns {number} 0–255
 */
export function scoreHsvPair(prev, cur) {
  if (!prev?.length || !cur?.length || prev.length !== cur.length) return 0
  const n = cur.length / 3
  if (n <= 0) return 0
  let sum = 0
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i])
    const hueDiff = Math.min(dh, 255 - dh)
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255
    sum += hueDiff * hueWeight
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2])
  }
  return sum / (n * 3)
}

/** 构造实心色块网格（测试用）。 */
export function solidGridRgb(r, g, b) {
  const out = new Float32Array(SCAN_W * SCAN_H * 3)
  for (let i = 0; i < out.length; i += 3) {
    out[i] = r
    out[i + 1] = g
    out[i + 2] = b
  }
  return out
}

/**
 * 经 sidecar 比较两张 PNG（base64 或 Buffer）。
 * @param {{ call: Function }} sidecar
 * @param {string | Buffer} pngA
 * @param {string | Buffer} pngB
 */
export async function scorePngPairViaSidecar(sidecar, pngA, pngB, timeoutMs = 15_000) {
  if (!sidecar || typeof sidecar.call !== 'function') {
    throw Object.assign(new Error('sidecar 不可用'), { code: 'SIDECAR_DOWN' })
  }
  const toB64 = (v) => (Buffer.isBuffer(v) ? v.toString('base64') : String(v))
  const resp = await sidecar.call('diff', {
    pngA: toB64(pngA),
    pngB: toB64(pngB),
  }, timeoutMs)
  if (!resp?.ok) {
    const err = resp?.error ?? {}
    throw Object.assign(new Error(err.message || 'diff 失败'), { code: err.code || 'DIFF_FAILED' })
  }
  return Number(resp.score) || 0
}

export function createHostScorer() {
  /** @type {Float32Array | null} */
  let prev = null
  return {
    reset() { prev = null },
    /**
     * @param {Float32Array | number[]} rgb
     * @returns {number | null}
     */
    pushRgb(rgb) {
      const hsv = rgbToHsv(rgb)
      if (!prev) {
        prev = Float32Array.from(hsv)
        return null
      }
      const score = scoreHsvPair(prev, hsv)
      prev = Float32Array.from(hsv)
      return score
    },
  }
}
