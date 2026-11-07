/**
 * 宿主图像 token 估算（42px 格口径）。
 * 公式来自公开「图像理解 · Token 用量」，代码自写。
 *
 * tokens = rows × (cols + 1) + 2
 * 格边 = 14×3 = 42px；小于 544² 按该面积计费。
 *
 * @module src/image-tokens.js
 */

export const IMAGE_PATCH = 14
export const IMAGE_DOWNSAMPLE = 3
export const IMAGE_CELL = IMAGE_PATCH * IMAGE_DOWNSAMPLE
export const IMAGE_TOKEN_CAP = 1024
export const IMAGE_UPSCALE_AREA = 544 * 544

/** 与 capture / mosaic 一致的画布（宽高均为 42 倍数）。 */
export const CANVAS_BY_QUALITY = Object.freeze({
  low: { w: 798, h: 462, tokens: 222 },
  standard: { w: 1050, h: 630, tokens: 392 },
  high: { w: 1260, h: 756, tokens: 560 },
})

const ceilDiv = (v, d) => Math.floor((v + d - 1) / d)
const intDiv = (v, d) => Math.floor(v / d)
const padToPatch = (px) => ceilDiv(px, IMAGE_PATCH) * IMAGE_PATCH
const gridCells = (padded) => ceilDiv(intDiv(padded, IMAGE_PATCH), IMAGE_DOWNSAMPLE)
const gridTokens = (rows, cols) => rows * (cols + 1) + 2

function projectSize(W, H, cap) {
  const tw = gridTokens(gridCells(padToPatch(H)), gridCells(padToPatch(W)))
  if (tw <= cap) return { W, H, tokens: tw }

  const aspect = H / W
  const idealW = Math.sqrt((cap - 2) / aspect + 0.25) - 0.5
  let solvedW = Math.trunc(idealW)
  let solvedH = Math.trunc(idealW * aspect)
  if (solvedW < 1) {
    solvedW = 1
    solvedH = intDiv(cap - 2, 2)
  } else if (solvedH < 1) {
    solvedH = 1
    solvedW = intDiv(cap - 2, solvedH) - 1
  }
  const scale = Math.min((solvedW * IMAGE_CELL) / W, (solvedH * IMAGE_CELL) / H)
  const bw = Math.trunc((W * scale) / IMAGE_PATCH) * IMAGE_PATCH
  const bh = Math.trunc((H * scale) / IMAGE_PATCH) * IMAGE_PATCH
  return { W: bw, H: bh, tokens: gridTokens(gridCells(bh), gridCells(bw)) }
}

/**
 * @param {number} w
 * @param {number} h
 * @returns {number}
 */
export function imageTokens(w, h) {
  let W = Math.round(Number(w) || 0)
  let H = Math.round(Number(h) || 0)
  if (W <= 0 || H <= 0) return 0

  const px = W * H
  if (px < IMAGE_UPSCALE_AREA) {
    const scale = Math.sqrt(IMAGE_UPSCALE_AREA / px)
    W = Math.max(1, Math.trunc(W * scale))
    H = Math.max(1, Math.trunc(H * scale))
  }

  let cur = projectSize(W, H, IMAGE_TOKEN_CAP)
  for (let i = 0; i < 10; i += 1) {
    const next = projectSize(cur.W, cur.H, IMAGE_TOKEN_CAP)
    if (next.tokens === cur.tokens && next.W === cur.W && next.H === cur.H) {
      return cur.tokens
    }
    cur = next
  }
  return cur.tokens
}

/** 宽度向下对齐到 42 的倍数。 */
export function alignDownToCell(px) {
  const n = Math.max(0, Math.floor(Number(px) || 0))
  return Math.floor(n / IMAGE_CELL) * IMAGE_CELL
}
