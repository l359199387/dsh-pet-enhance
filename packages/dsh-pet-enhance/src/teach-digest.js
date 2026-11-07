/**
 * 教学 digest 省 token：变化分去重 + 按 4 帧拆成多张 2×2 拼图再喂模型。
 * 本地盘上的逐帧仍全留；只压缩「理解那一次」的附图成本。
 *
 * @module src/teach-digest.js
 */

import { formatMouseButtonLabel } from './teach-store.js'

/** 连续两帧变化分低于此值视为重复（与选帧 dupMin 同口径）。 */
export const DIGEST_DEDUP_MIN = 8
/** 喂模型前抽样上限（可拆成多张 2×2）。 */
export const DIGEST_MOSAIC_MAX = 8
/** 每张拼图最多几格（与 mosaic.MAX_FRAMES / 盯屏 2×2 对齐）。 */
export const DIGEST_SHEET_FRAMES = 4
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

/** 按每张上限切成多批（默认 4 → 多张 2×2）。 */
export function chunkFramesForSheets(frames, sheetSize = DIGEST_SHEET_FRAMES) {
  const list = Array.isArray(frames) ? frames : []
  const size = Math.max(1, Math.trunc(Number(sheetSize) || DIGEST_SHEET_FRAMES))
  const out = []
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size))
  }
  return out
}

/**
 * @param {object[]} batch
 * @param {number} indexBase 全局格号起点（0-based）
 * @param {number} sheetIndex 0-based
 * @param {number} sheetTotal
 * @param {string} quality
 * @param {{ call: Function }} sidecar
 * @param {(m: string) => void} log
 */
async function composeOneSheet(batch, indexBase, sheetIndex, sheetTotal, quality, sidecar, log) {
  const labels = batch.map((f, i) => cellLabel(f, indexBase + i))
  const resp = await sidecar.call('mosaic', {
    quality,
    frames: batch.map((f, i) => ({
      png: f.png.toString('base64'),
      label: labels[i],
    })),
  }, 30_000)
  if (!resp?.ok || !resp.png) {
    log(`teach-digest 拼图#${sheetIndex + 1} 失败：${resp?.error?.message || 'no-png'}`)
    return null
  }
  const png = Buffer.from(String(resp.png), 'base64')
  const cells = batch.map((f, i) => ({
    index: indexBase + i + 1,
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
  const n = sheetIndex + 1
  const file = sheetTotal > 1 ? `digest-mosaic-${n}of${sheetTotal}.png` : 'digest-mosaic.png'
  return {
    role: 'mosaic',
    reason: 'digest-mosaic',
    file,
    name: file,
    png,
    mosaic: true,
    sheetIndex: n,
    sheetTotal,
    cells,
    sourceCount: batch.length,
    width: Number(resp.w) || null,
    height: Number(resp.h) || null,
    cols: Number(resp.cols) || null,
    rows: Number(resp.rows) || null,
    quality,
    tokensHint: quality === 'low' ? 222 : undefined,
  }
}

/**
 * 均匀抽样 → 去重 → 按 4 帧拆成多张 2×2。失败则退回多图列表。
 * @param {object[]} frameList
 * @param {{
 *   readPng: (frame: object) => Promise<Buffer | null>,
 *   sidecar?: { call: Function } | null,
 *   limit?: number,
 *   sheetSize?: number,
 *   quality?: string,
 *   log?: (m: string) => void,
 * }} options
 * @returns {Promise<object[]>}
 */
export async function buildTeachDigestImages(frameList, options) {
  const limit = options.limit ?? DIGEST_MOSAIC_MAX
  const sheetSize = options.sheetSize ?? DIGEST_SHEET_FRAMES
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

  if (!options.sidecar || typeof options.sidecar.call !== 'function') {
    return deduped
  }

  const batches = chunkFramesForSheets(deduped, sheetSize)
  /** @type {object[]} */
  const sheets = []
  let indexBase = 0
  try {
    for (let s = 0; s < batches.length; s += 1) {
      const batch = batches[s]
      const sheet = await composeOneSheet(
        batch,
        indexBase,
        s,
        batches.length,
        quality,
        options.sidecar,
        log,
      )
      if (!sheet) {
        log('teach-digest 拼图失败，退回多图')
        return deduped
      }
      sheets.push(sheet)
      indexBase += batch.length
    }
  } catch (e) {
    log(`teach-digest 拼图异常，退回多图：${e?.message ?? e}`)
    return deduped
  }

  log(
    `teach-digest 拼图完成：${deduped.length} 帧 → ${sheets.length} 张`
    + `（每张最多 ${sheetSize} 格）`,
  )
  return sheets
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
  const mosaics = images.filter((img) => img?.mosaic && Array.isArray(img.cells))
  if (mosaics.length === images.length && mosaics.length > 0) {
    return describeMosaicSheetsForPrompt(mosaics)
  }
  return describeMultiForPrompt(images)
}

function describeMosaicSheetsForPrompt(mosaics) {
  const totalCells = mosaics.reduce(
    (n, m) => n + (Number(m.sourceCount) || m.cells?.length || 0),
    0,
  )
  const sheetN = mosaics.length
  const lines = [
    sheetN > 1
      ? `附图共 ${sheetN} 张拼图（按时间顺序，多为 2×2，合计约 ${sheetN * 222} token），`
        + `内含 ${totalCells} 格证据；请按「图号 + 格号」看，不要把某张当单一截图。`
      : `附图是 1 张拼图（${mosaics[0].cols || '?'}×${mosaics[0].rows || '?'}，约 ${mosaics[0].tokensHint || '222'} token），`
        + `内含 ${totalCells} 格证据；请按「格号」看，不要把整张当单一截图。`,
  ]
  for (const mosaic of mosaics) {
    const sheetTag = sheetN > 1 ? `图${mosaic.sheetIndex || 1}/${sheetN}` : null
    if (sheetTag) {
      lines.push(
        `${sheetTag}（${mosaic.cols || '?'}×${mosaic.rows || '?'}，${mosaic.sourceCount || mosaic.cells.length} 格）：`,
      )
    }
    for (const cell of mosaic.cells) {
      lines.push(formatCellLine(cell, sheetTag))
    }
  }
  return lines.join('\n')
}

function formatCellLine(cell, sheetTag) {
  const tag = sheetTag
    ? `${sheetTag}·格${cell.index}「${cell.label}」`
    : `格${cell.index}「${cell.label}」`
  if (cell.role === 'click' && cell.click) {
    const c = cell.click
    const size = (c.imageW && c.imageH) ? `${c.imageW}×${c.imageH}` : `${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
    const btn = formatMouseButtonLabel(c.button)
    const act = c.action === 'double_click' ? `${btn}双击` : `${btn}点击`
    return (
      `${tag}：步骤#${c.eventI} ${act}；请在**本格内**看坐标 (${c.imageX},${c.imageY})，`
      + `原小图 ${size}（勿用整屏坐标、勿用拼图全局坐标）`
      + (cell.window ? ` @「${String(cell.window).slice(0, 40)}」` : '')
    )
  }
  if (cell.role === 'scroll' && cell.scroll) {
    const c = cell.scroll
    const size = (c.imageW && c.imageH) ? `${c.imageW}×${c.imageH}` : `${CLICK_CROP_SIZE}×${CLICK_CROP_SIZE}`
    const phase = c.phase === 'start' ? '滚动开始' : '滚动结束'
    const axis = c.horizontal ? '横向' : '纵向'
    return (
      `${tag}：步骤#${c.eventI} 滑轮${axis}${phase} δ=${c.delta || 0}；`
      + `光标在**本格内** (${c.imageX},${c.imageY})，原小图 ${size}`
      + (cell.window ? ` @「${String(cell.window).slice(0, 40)}」` : '')
    )
  }
  return `${tag}：上下文/${cell.reason || cell.role}（辅助，非点击落点）`
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

/** digest 实际「证据格数」（拼图时累加 cells，否则用张数）。 */
export function digestEvidenceCount(images) {
  if (!images?.length) return 0
  const mosaics = images.filter((img) => img?.mosaic)
  if (mosaics.length === images.length && mosaics.length > 0) {
    return mosaics.reduce(
      (n, m) => n + (Number(m.sourceCount) || m.cells?.length || 0),
      0,
    )
  }
  return images.length
}
