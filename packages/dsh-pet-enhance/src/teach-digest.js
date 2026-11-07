/**
 * 教学 digest 省 token：变化分去重 + 多帧拼一张再喂模型。
 * 本地盘上的逐帧仍全留；只压缩「理解那一次」的附图成本。
 *
 * @module src/teach-digest.js
 */

import { formatMouseButtonLabel } from './teach-store.js'

/** 连续两帧变化分低于此值视为重复（与选帧 dupMin 同口径）。 */
export const DIGEST_DEDUP_MIN = 8
/** 拼图最多格数（= 喂模型前抽样上限）。 */
export const DIGEST_MOSAIC_MAX = 8
export const DIGEST_MOSAIC_QUALITY = 'low'
const CLICK_CROP_SIZE = 400

/** 从过多证据帧里均匀抽 N 张（保留首尾）。与 teach-frames.sampleFramesForDigest 同口径。 */
export function sampleFramesForDigest(frameList, limit = DIGEST_MOSAIC_MAX) {
  const evidence = (frameList || []).filter((f) => f.role === 'click' || f.role === 'scroll')
  const context = (frameList || []).filter((f) => f.role === 'key' || f.role === 'supplement')
  const pool = evidence.length ? evidence : context
  if (pool.length <= limit) return pool.slice()
  const idxs = new Set([0, pool.length - 1])
  const mid = Math.max(1, limit - 2)
  for (let i = 1; i <= mid; i += 1) {
    idxs.add(Math.round((i * (pool.length - 1)) / (mid + 1)))
  }
  return [...idxs].sort((a, b) => a - b).slice(0, limit).map((i) => pool[i])
}

/**
 * 在已抽样列表上做相邻去重。prefer 保留带 click/scroll 坐标的帧。
 * @param {object[]} items 含 png Buffer
 * @param {{
 *   sidecar?: { call: Function } | null,
 *   minScore?: number,
 *   log?: (m: string) => void,
 * }} [opts]
 */
export async function dedupeDigestItems(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter((x) => x?.png?.byteLength) : []
  if (list.length <= 1) return list.slice()

  const minScore = opts.minScore ?? DIGEST_DEDUP_MIN
  const sidecar = opts.sidecar
  const log = opts.log ?? (() => {})
  const out = [list[0]]

  for (let i = 1; i < list.length; i += 1) {
    const prev = out[out.length - 1]
    const cur = list[i]
    let score = Infinity

    if (Buffer.isBuffer(prev.png) && Buffer.isBuffer(cur.png) && prev.png.equals(cur.png)) {
      score = 0
    } else if (sidecar && typeof sidecar.call === 'function') {
      try {
        const resp = await sidecar.call('diff', {
          pngA: prev.png.toString('base64'),
          pngB: cur.png.toString('base64'),
        }, 10_000)
        if (resp?.ok) score = Number(resp.score) || 0
      } catch (e) {
        log(`teach-digest 去重 diff 失败：${e?.message ?? e}`)
      }
    }

    if (score < minScore) {
      // 重复：优先留下有点击/滑轮元数据的那张
      const prevEvidence = Boolean(prev.click || prev.scroll)
      const curEvidence = Boolean(cur.click || cur.scroll)
      if (!prevEvidence && curEvidence) {
        out[out.length - 1] = cur
      }
      log(`teach-digest 去重：丢弃近似帧 score=${Number(score).toFixed(2)}`)
      continue
    }
    out.push(cur)
  }
  return out
}

/**
 * 均匀抽样 → 去重 → 拼图。失败则退回多图列表。
 * @param {object[]} frameList
 * @param {{
 *   readPng: (frame: object) => Promise<Buffer | null>,
 *   sidecar?: { call: Function } | null,
 *   limit?: number,
 *   quality?: string,
 *   log?: (m: string) => void,
 * }} options
 * @returns {Promise<object[]>}
 */
export async function buildTeachDigestImages(frameList, options) {
  const limit = options.limit ?? DIGEST_MOSAIC_MAX
  const quality = options.quality ?? DIGEST_MOSAIC_QUALITY
  const log = options.log ?? (() => {})
  const picked = sampleFramesForDigest(frameList, limit)
  const loaded = []
  for (const f of picked) {
    try {
      const png = await options.readPng(f)
      if (png?.byteLength) loaded.push({ ...f, png, name: f.file })
    } catch { /* skip */ }
  }
  if (!loaded.length) return []

  const deduped = await dedupeDigestItems(loaded, {
    sidecar: options.sidecar,
    log,
  })
  if (!deduped.length) return []

  // 无 sidecar 或仅 1 格：仍可单张交图（1 格也走 mosaic 锁 token 表）
  if (!options.sidecar || typeof options.sidecar.call !== 'function') {
    return deduped
  }

  try {
    const labels = deduped.map((f, i) => cellLabel(f, i))
    const resp = await options.sidecar.call('mosaic', {
      quality,
      frames: deduped.map((f, i) => ({
        png: f.png.toString('base64'),
        label: labels[i],
      })),
    }, 30_000)
    if (!resp?.ok || !resp.png) {
      log(`teach-digest 拼图失败，退回多图：${resp?.error?.message || 'no-png'}`)
      return deduped
    }
    const png = Buffer.from(String(resp.png), 'base64')
    const cells = deduped.map((f, i) => ({
      index: i + 1,
      label: labels[i],
      role: f.role,
      reason: f.reason,
      file: f.file,
      window: f.window,
      click: f.click,
      scroll: f.scroll,
      imageW: f.imageW,
      imageH: f.imageH,
    }))
    return [{
      role: 'mosaic',
      reason: 'digest-mosaic',
      file: 'digest-mosaic.png',
      name: 'digest-mosaic.png',
      png,
      mosaic: true,
      cells,
      sourceCount: deduped.length,
      width: Number(resp.w) || null,
      height: Number(resp.h) || null,
      cols: Number(resp.cols) || null,
      rows: Number(resp.rows) || null,
      quality,
      tokensHint: quality === 'low' ? 222 : undefined,
    }]
  } catch (e) {
    log(`teach-digest 拼图异常，退回多图：${e?.message ?? e}`)
    return deduped
  }
}

function cellLabel(frame, index) {
  const n = index + 1
  const meta = frame.click || frame.scroll
  if (meta?.eventI != null) return `${n}#${meta.eventI}`
  if (frame.role === 'key' || frame.role === 'supplement') return `${n}ctx`
  return String(n)
}

/**
 * 拼图 / 多图 共用的附图说明（digest 提示）。
 * @param {object[]} images
 */
export function describeDigestImagesForPrompt(images) {
  if (!images?.length) return ''
  if (images.length === 1 && images[0].mosaic && Array.isArray(images[0].cells)) {
    return describeMosaicForPrompt(images[0])
  }
  // 与旧 describeClickFramesForPrompt 同形，避免循环依赖处再 import
  return describeMultiForPrompt(images)
}

function describeMosaicForPrompt(mosaic) {
  const lines = [
    `附图是 1 张拼图（${mosaic.cols || '?'}×${mosaic.rows || '?'}，约 ${mosaic.tokensHint || '222'} token），`
    + `内含 ${mosaic.sourceCount || mosaic.cells.length} 格证据；请按「格号」看，不要把整张当单一截图。`,
  ]
  for (const cell of mosaic.cells) {
    const tag = `格${cell.index}「${cell.label}」`
    if (cell.role === 'click' && cell.click) {
      const c = cell.click
      const size = (c.imageW && c.imageH) ? `${c.imageW}×${c.imageH}` : `${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
      const btn = formatMouseButtonLabel(c.button)
      const act = c.action === 'double_click' ? `${btn}双击` : `${btn}点击`
      lines.push(
        `${tag}：步骤#${c.eventI} ${act}；请在**本格内**看坐标 (${c.imageX},${c.imageY})，`
        + `原小图 ${size}（勿用整屏坐标、勿用拼图全局坐标）`
        + (cell.window ? ` @「${String(cell.window).slice(0, 40)}」` : ''),
      )
    } else if (cell.role === 'scroll' && cell.scroll) {
      const c = cell.scroll
      const size = (c.imageW && c.imageH) ? `${c.imageW}×${c.imageH}` : `${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
      const phase = c.phase === 'start' ? '滚动开始' : '滚动结束'
      const axis = c.horizontal ? '横向' : '纵向'
      lines.push(
        `${tag}：步骤#${c.eventI} 滑轮${axis}${phase} δ=${c.delta || 0}；`
        + `光标在**本格内** (${c.imageX},${c.imageY})，原小图 ${size}`
        + (cell.window ? ` @「${String(cell.window).slice(0, 40)}」` : ''),
      )
    } else {
      lines.push(`${tag}：上下文/${cell.reason || cell.role}（辅助，非点击落点）`)
    }
  }
  return lines.join('\n')
}

function describeMultiForPrompt(images) {
  const lines = []
  let n = 0
  for (const img of images || []) {
    n += 1
    if (img.role === 'click' && img.click) {
      const c = img.click
      const size = (c.imageW && c.imageH) ? `${c.imageW}×${c.imageH}` : `${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
      const crop = c.crop
        ? `鼠标附近裁切 ${c.crop.w}×${c.crop.h}`
        : `鼠标附近约 ${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
      const btn = formatMouseButtonLabel(c.button)
      const act = c.action === 'double_click' ? `${btn}双击` : `${btn}点击`
      lines.push(
        `图${n}（${img.name || img.file}）：步骤#${c.eventI} ${act}，${crop}；`
        + `请在本图上看图内坐标 (${c.imageX},${c.imageY})，图规格 ${size}`
        + '（勿用整屏坐标）'
        + (img.window ? ` @「${String(img.window).slice(0, 40)}」` : ''),
      )
    } else if (img.role === 'scroll' && img.scroll) {
      const c = img.scroll
      const size = (c.imageW && c.imageH) ? `${c.imageW}×${c.imageH}` : `${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
      const crop = c.crop
        ? `鼠标附近裁切 ${c.crop.w}×${c.crop.h}`
        : `鼠标附近约 ${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
      const phase = c.phase === 'start' ? '滚动开始' : '滚动结束'
      const axis = c.horizontal ? '横向' : '纵向'
      lines.push(
        `图${n}（${img.name || img.file}）：步骤#${c.eventI} 滑轮${axis}${phase} δ=${c.delta || 0}，${crop}；`
        + `光标图内坐标 (${c.imageX},${c.imageY})，图规格 ${size}`
        + '（勿用整屏坐标；中间滚动格不截图）'
        + (img.window ? ` @「${String(img.window).slice(0, 40)}」` : ''),
      )
    } else {
      lines.push(`图${n}（${img.name || img.file}）：上下文/${img.reason || img.role}（整屏缩略，仅辅助）`)
    }
  }
  return lines.join('\n')
}

/** digest 实际「证据格数」（拼图时用 cells，否则用张数）。 */
export function digestEvidenceCount(images) {
  if (!images?.length) return 0
  if (images.length === 1 && images[0].mosaic) {
    return Number(images[0].sourceCount) || images[0].cells?.length || 1
  }
  return images.length
}
