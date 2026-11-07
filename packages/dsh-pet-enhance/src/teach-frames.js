/**
 * 教学帧：每次点击抓鼠标附近小图（默认 400×400）并绑定图内坐标；
 * 上下文关键帧仍整屏 low 控量。图只供学会；执行不再带图。
 *
 * @module src/teach-frames.js
 */

import { mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFrame } from './capture.js'
import {
  buildTeachDigestImages,
  describeDigestImagesForPrompt,
  DIGEST_BUDGET,
  DIGEST_SHEET_FRAMES,
  sampleFramesForDigest as sampleDigestPool,
} from './teach-digest.js'

/** 开场/换窗/收尾等上下文关键帧上限（不含点击帧） */
export const MAX_KEY_FRAMES = 5
export const MAX_SUPPLEMENT_FRAMES = 2
/** 点击帧软上限，防止极端连点撑爆磁盘/token */
export const MAX_CLICK_FRAMES = 40
/** 滑轮起止帧软上限（每次手势 2 张） */
export const MAX_SCROLL_FRAMES = 24
/**
 * 理解阶段喂模型的格数硬顶（点击优先；普通帧少喂，见 DIGEST_BUDGET）。
 * 交图：去重后按 4 帧拆多张 2×2。
 */
export const MAX_DIGEST_IMAGES = DIGEST_BUDGET.absoluteMax
/** 理解阶段最多交几张拼图 */
export const MAX_DIGEST_SHEETS = Math.ceil(DIGEST_BUDGET.absoluteMax / DIGEST_SHEET_FRAMES)
/** @deprecated 旧合计上限；现点击/滑轮帧单独预算 */
export const MAX_TOTAL_FRAMES = MAX_KEY_FRAMES + MAX_SUPPLEMENT_FRAMES + MAX_CLICK_FRAMES + MAX_SCROLL_FRAMES

/** 点击/滑轮优先抽样（见 teach-digest.sampleFramesForDigest）。 */
export function sampleFramesForDigest(frameList, limitOrOpts) {
  return sampleDigestPool(frameList, limitOrOpts)
}

/** 点击证据：鼠标附近正方形边长（屏幕像素） */
export const CLICK_CROP_SIZE = 400
/** 点击小图清晰度：standard（区域已小，几乎不缩放，token 可控） */
export const CLICK_CAPTURE_QUALITY = 'standard'

export function teachFramesDir(home, sessionId) {
  return join(home, 'teach', `${sessionId}-frames`)
}

export function learnedFramesDir(home, learnedId) {
  return join(home, 'learned', learnedId, 'frames')
}

/**
 * 从 hello.screen / shot.screen 取虚拟桌面边界（可含负坐标多屏）。
 * @param {{ w?: number, h?: number, width?: number, height?: number, virtual?: { x?: number, y?: number, w?: number, h?: number } } | null | undefined} screen
 */
export function resolveVirtualBounds(screen) {
  const v = screen?.virtual
  if (v && Number(v.w) > 0 && Number(v.h) > 0) {
    return {
      x: Number(v.x) || 0,
      y: Number(v.y) || 0,
      w: Number(v.w),
      h: Number(v.h),
    }
  }
  const w = Number(screen?.w ?? screen?.width) || 0
  const h = Number(screen?.h ?? screen?.height) || 0
  if (w > 0 && h > 0) return { x: 0, y: 0, w, h }
  return null
}

/**
 * 以点击为中心裁 400×400（贴边收缩），返回屏幕 region。
 * @param {number} screenX
 * @param {number} screenY
 * @param {{ x: number, y: number, w: number, h: number } | null} [bounds]
 * @param {number} [size]
 */
export function clickCropRegion(screenX, screenY, bounds = null, size = CLICK_CROP_SIZE) {
  const side = Math.max(32, Math.round(Number(size) || CLICK_CROP_SIZE))
  const half = Math.floor(side / 2)
  let x = Math.round(Number(screenX)) - half
  let y = Math.round(Number(screenY)) - half
  let w = side
  let h = side
  if (bounds && bounds.w > 0 && bounds.h > 0) {
    const maxX = bounds.x + bounds.w
    const maxY = bounds.y + bounds.h
    if (x < bounds.x) x = bounds.x
    if (y < bounds.y) y = bounds.y
    if (x + w > maxX) x = Math.max(bounds.x, maxX - w)
    if (y + h > maxY) y = Math.max(bounds.y, maxY - h)
    w = Math.min(w, Math.max(1, maxX - x))
    h = Math.min(h, Math.max(1, maxY - y))
  }
  return { x, y, w, h }
}

/**
 * 点击落点 → 裁切图内像素（若 sidecar 又按 max_width 缩放，再乘缩放比）。
 * @param {number} screenX
 * @param {number} screenY
 * @param {{ x: number, y: number, w: number, h: number }} region
 * @param {{ width?: number, height?: number } | null} [shot]
 */
export function mapClickToCropImage(screenX, screenY, region, shot = null) {
  const imgW = Number(shot?.width) || region.w
  const imgH = Number(shot?.height) || region.h
  const localX = Number(screenX) - region.x
  const localY = Number(screenY) - region.y
  const scaleX = region.w > 0 ? imgW / region.w : 1
  const scaleY = region.h > 0 ? imgH / region.h : 1
  let imageX = Math.round(localX * scaleX)
  let imageY = Math.round(localY * scaleY)
  if (imgW > 0) imageX = Math.max(0, Math.min(imgW - 1, imageX))
  if (imgH > 0) imageY = Math.max(0, Math.min(imgH - 1, imageY))
  return {
    imageX,
    imageY,
    imageW: imgW,
    imageH: imgH,
    mapped: true,
    region: { x: region.x, y: region.y, w: region.w, h: region.h },
  }
}

/**
 * @deprecated 整屏映射；点击请用 mapClickToCropImage。
 */
export function mapScreenToImageCoords(screenX, screenY, shot) {
  const imgW = Number(shot?.width) || 0
  const imgH = Number(shot?.height) || 0
  const screen = shot?.screen || {}
  const screenW = Number(screen.w ?? screen.width) || 0
  const screenH = Number(screen.h ?? screen.height) || 0
  const sx = Number(screenX)
  const sy = Number(screenY)
  if (![sx, sy].every(Number.isFinite)) {
    return { imageX: null, imageY: null, imageW: imgW || null, imageH: imgH || null, mapped: false }
  }
  if (imgW > 0 && imgH > 0 && screenW > 0 && screenH > 0) {
    return {
      imageX: Math.round(sx * (imgW / screenW)),
      imageY: Math.round(sy * (imgH / screenH)),
      imageW: imgW,
      imageH: imgH,
      mapped: true,
    }
  }
  return {
    imageX: Math.round(sx),
    imageY: Math.round(sy),
    imageW: imgW || null,
    imageH: imgH || null,
    mapped: false,
  }
}

/**
 * @param {{
 *   home: string,
 *   sessionId: string,
 *   sidecar?: object | (() => object | null | undefined),
 *   capture?: typeof captureFrame,
 *   log?: (m: string) => void,
 * }} options
 */
export function createFrameRecorder(options) {
  const capture = options.capture ?? captureFrame
  const log = options.log ?? (() => {})
  /** @type {object[]} */
  const frames = []
  /** 最近抓到的 png，供补图（内存，最多 4） */
  const recent = []
  let lastWindow = ''
  let seq = 0

  function sidecar() {
    return typeof options.sidecar === 'function' ? options.sidecar() : options.sidecar
  }

  function keyCount() {
    return frames.filter((f) => f.role === 'key').length
  }

  function supplementCount() {
    return frames.filter((f) => f.role === 'supplement').length
  }

  function clickCount() {
    return frames.filter((f) => f.role === 'click').length
  }

  function scrollCount() {
    return frames.filter((f) => f.role === 'scroll').length
  }

  async function writePng(buf, file) {
    const dir = teachFramesDir(options.home, options.sessionId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, file)
    await writeFile(path, buf)
    return path
  }

  function helloScreen() {
    const sc = sidecar()
    try {
      return sc?.getHello?.()?.screen ?? null
    } catch {
      return null
    }
  }

  async function grabShot({ quality = 'low', region = null } = {}) {
    const sc = sidecar()
    const shot = await capture({
      quality,
      home: options.home,
      sidecar: sc,
      region: region || undefined,
      timeoutMs: 8_000,
    })
    if (!shot?.png?.byteLength) return null
    if (!shot.screen) {
      const hs = helloScreen()
      if (hs) shot.screen = hs
    }
    return shot
  }

  /**
   * @param {string} reason start|window|end|mid|supplement-before|supplement-after|click
   * @param {'key'|'supplement'|'click'} role
   * @param {object} [extra]
   */
  async function snap(reason, role = 'key', extra = {}) {
    if (role === 'key' && keyCount() >= MAX_KEY_FRAMES) return null
    if (role === 'supplement' && supplementCount() >= MAX_SUPPLEMENT_FRAMES) return null
    if (role === 'click' && clickCount() >= MAX_CLICK_FRAMES) return null

    try {
      const shot = await grabShot()
      if (!shot) return null

      const i = seq
      seq += 1
      const file = `${String(i).padStart(2, '0')}-${role}-${reason}.png`
      await writePng(shot.png, file)
      const win = shot.window?.title || shot.active?.title || extra.window || null
      const entry = {
        i,
        reason,
        role,
        file,
        window: win ? String(win).slice(0, 80) : null,
        at: new Date().toISOString(),
        bytes: shot.png.byteLength,
        imageW: Number(shot.width) || null,
        imageH: Number(shot.height) || null,
        ...extra,
      }
      frames.push(entry)
      recent.push({ png: shot.png, entry })
      if (recent.length > 4) recent.shift()
      if (win) lastWindow = win
      log(`teach-frame：${role}/${reason} #${i} ${file}`)
      return entry
    } catch (e) {
      log(`teach-frame 失败：${e?.message ?? e}`)
      return null
    }
  }

  /**
   * 鼠标附近 400×400 证据帧（点击 / 滑轮起止共用）。
   * @param {{
   *   eventI: number,
   *   x: number,
   *   y: number,
   *   role: 'click'|'scroll',
   *   reason: string,
   *   meta?: object,
   *   window?: string | null,
   * }} info
   */
  async function snapNearCursor(info) {
    const role = info.role === 'scroll' ? 'scroll' : 'click'
    if (role === 'click' && clickCount() >= MAX_CLICK_FRAMES) {
      log(`teach-frame：点击帧已达上限 ${MAX_CLICK_FRAMES}`)
      return null
    }
    if (role === 'scroll' && scrollCount() >= MAX_SCROLL_FRAMES) {
      log(`teach-frame：滑轮帧已达上限 ${MAX_SCROLL_FRAMES}`)
      return null
    }
    try {
      const bounds = resolveVirtualBounds(helloScreen())
      const region = clickCropRegion(info.x, info.y, bounds, CLICK_CROP_SIZE)
      const shot = await grabShot({ quality: CLICK_CAPTURE_QUALITY, region })
      if (!shot) return null
      const mapped = mapClickToCropImage(info.x, info.y, region, shot)
      const i = seq
      seq += 1
      const reason = String(info.reason || role)
      const file = `${String(i).padStart(2, '0')}-${role}-step${info.eventI}.png`
      await writePng(shot.png, file)
      const win = info.window || shot.window?.title || shot.active?.title || null
      const pointer = {
        eventI: info.eventI,
        role,
        reason,
        screenX: Number(info.x),
        screenY: Number(info.y),
        imageX: mapped.imageX,
        imageY: mapped.imageY,
        imageW: mapped.imageW,
        imageH: mapped.imageH,
        mapped: mapped.mapped,
        crop: mapped.region,
        cropSize: CLICK_CROP_SIZE,
        quality: CLICK_CAPTURE_QUALITY,
        ...(info.meta || {}),
      }
      const entry = {
        i,
        reason,
        role,
        file,
        window: win ? String(win).slice(0, 80) : null,
        at: new Date().toISOString(),
        bytes: shot.png.byteLength,
        imageW: mapped.imageW,
        imageH: mapped.imageH,
        click: role === 'click' ? pointer : undefined,
        scroll: role === 'scroll' ? pointer : undefined,
      }
      frames.push(entry)
      recent.push({ png: shot.png, entry })
      if (recent.length > 4) recent.shift()
      if (win) lastWindow = String(win)
      log(
        `teach-frame：${role}/${reason} #${i} step${info.eventI} `
        + `crop ${region.w}×${region.h}@(${region.x},${region.y}) `
        + `→img(${pointer.imageX},${pointer.imageY}/${pointer.imageW}×${pointer.imageH}) ${file}`,
      )
      return entry
    } catch (e) {
      log(`teach-frame ${role} 截图失败：${e?.message ?? e}`)
      return null
    }
  }

  /** 任意鼠标键点击：抓鼠标附近小图。 */
  async function snapOnClick(info) {
    return snapNearCursor({
      eventI: info.eventI,
      x: info.x,
      y: info.y,
      role: 'click',
      reason: 'click',
      window: info.window,
      meta: {
        action: String(info.action || 'click'),
        button: info.button || 'left',
      },
    })
  }

  /** 滑轮手势开始/结束：各抓一张鼠标附近小图（中间滚动不截）。 */
  async function snapOnScrollBoundary(info) {
    const phase = info.phase === 'start' ? 'start' : 'end'
    return snapNearCursor({
      eventI: info.eventI,
      x: info.x,
      y: info.y,
      role: 'scroll',
      reason: phase === 'start' ? 'scroll-start' : 'scroll-end',
      window: info.window,
      meta: {
        action: 'scroll',
        phase,
        delta: Number(info.delta) || 0,
        horizontal: Boolean(info.horizontal),
      },
    })
  }

  /** 窗口标题变化时抓上下文帧（控量；点击帧已覆盖主证据）。 */
  async function maybeOnWindow(title) {
    const t = String(title || '').trim()
    if (!t || t === lastWindow) return null
    lastWindow = t
    if (keyCount() >= MAX_KEY_FRAMES) return null
    if (keyCount() >= MAX_KEY_FRAMES - 1) return null
    return snap('window', 'key')
  }

  async function snapStart() {
    return snap('start', 'key')
  }

  async function snapEnd() {
    return snap('end', 'key')
  }

  /**
   * 理解不够时补前后帧：优先用内存 recent；不够再现抓。
   * @param {'before'|'after'} which
   */
  async function supplement(which) {
    if (supplementCount() >= MAX_SUPPLEMENT_FRAMES) return null
    if (which === 'before' && recent.length >= 2) {
      const prev = recent[recent.length - 2]
      if (prev && !frames.some((f) => f.file === prev.entry.file && f.role === 'supplement')) {
        const i = seq
        seq += 1
        const file = `${String(i).padStart(2, '0')}-supplement-before.png`
        await writePng(prev.png, file)
        const entry = {
          i,
          reason: 'supplement-before',
          role: 'supplement',
          file,
          window: prev.entry.window,
          at: new Date().toISOString(),
          bytes: prev.png.byteLength,
          imageW: prev.entry.imageW ?? null,
          imageH: prev.entry.imageH ?? null,
          click: prev.entry.click || undefined,
        }
        frames.push(entry)
        return entry
      }
    }
    return snap(which === 'before' ? 'supplement-before' : 'supplement-after', 'supplement')
  }

  function framePublicMeta(f) {
    const base = {
      i: f.i,
      reason: f.reason,
      role: f.role,
      file: f.file,
      window: f.window,
      at: f.at,
      bytes: f.bytes,
      imageW: f.imageW ?? null,
      imageH: f.imageH ?? null,
    }
    if (f.click) base.click = f.click
    if (f.scroll) base.scroll = f.scroll
    return base
  }

  async function writeManifest() {
    const dir = teachFramesDir(options.home, options.sessionId)
    await mkdir(dir, { recursive: true })
    const manifest = {
      sessionId: options.sessionId,
      maxKey: MAX_KEY_FRAMES,
      maxSupplement: MAX_SUPPLEMENT_FRAMES,
      maxClick: MAX_CLICK_FRAMES,
      maxScroll: MAX_SCROLL_FRAMES,
      frames: frames.map(framePublicMeta),
    }
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return manifest
  }

  /** 拷到 learned/<id>/frames，供学习目录完整保存；执行路径不读这些图。 */
  async function promoteToLearned(learnedId) {
    const srcDir = teachFramesDir(options.home, options.sessionId)
    const destDir = learnedFramesDir(options.home, learnedId)
    await mkdir(destDir, { recursive: true })
    const manifest = await writeManifest()
    for (const f of frames) {
      await copyFile(join(srcDir, f.file), join(destDir, f.file)).catch(() => {})
    }
    await writeFile(join(destDir, 'manifest.json'), `${JSON.stringify({
      ...manifest,
      learnedId,
      forLearningOnly: true,
      note: '自动化执行不要加载这些图片；点击帧含图内坐标仅供学习理解',
    }, null, 2)}\n`, 'utf8')
    return {
      dir: destDir,
      count: frames.length,
      files: frames.map((f) => f.file),
      clicks: frames.filter((f) => f.role === 'click').length,
      scrolls: frames.filter((f) => f.role === 'scroll').length,
    }
  }

  /**
   * 理解阶段优先喂点击/滑轮附近图（带坐标），再上下文/补图。
   * @param {number} [limit]
   */
  async function loadPngBuffers(limit = MAX_TOTAL_FRAMES) {
    const dir = teachFramesDir(options.home, options.sessionId)
    const ordered = [
      ...frames.filter((f) => f.role === 'click' || f.role === 'scroll'),
      ...frames.filter((f) => f.role === 'key'),
      ...frames.filter((f) => f.role === 'supplement'),
    ].slice(0, limit)
    const out = []
    for (const f of ordered) {
      try {
        const path = join(dir, f.file)
        const png = await readFile(path)
        out.push({ ...f, png, name: f.file, path })
      } catch { /* skip */ }
    }
    return out
  }

  /**
   * 专供 digest：均匀抽样 → 变化分去重 → 按 4 帧拆成多张 2×2（省 token）。
   * 拼图失败时退回最多 `limit` 张分图。
   */
  async function loadDigestImages(limit = MAX_DIGEST_IMAGES) {
    const dir = teachFramesDir(options.home, options.sessionId)
    const images = await buildTeachDigestImages(frames, {
      limit,
      sidecar: sidecar(),
      log,
      async readPng(f) {
        return readFile(join(dir, f.file))
      },
    })
    return images.map((img) => ({
      ...img,
      path: img.mosaic ? join(dir, img.file || 'digest-mosaic.png') : join(dir, img.file),
      name: img.name || img.file,
    }))
  }

  return {
    snapStart,
    snapEnd,
    snapOnClick,
    snapOnScrollBoundary,
    maybeOnWindow,
    supplement,
    writeManifest,
    promoteToLearned,
    loadPngBuffers,
    loadDigestImages,
    list: () => frames.slice(),
    keyCount,
    clickCount,
    scrollCount,
    lastWindow: () => lastWindow,
  }
}

/**
 * 把点击帧的图内坐标写回 playbook glance 步。
 * @param {object} playbook
 * @param {object[]} frameList
 */
export function attachClickFramesToPlaybook(playbook, frameList) {
  const byEvent = new Map()
  for (const f of frameList || []) {
    const meta = f.role === 'click' ? f.click : f.role === 'scroll' ? f.scroll : null
    if (meta && meta.eventI != null) byEvent.set(meta.eventI, f)
  }
  for (const s of playbook?.steps || []) {
    if (s.action !== 'click' && s.action !== 'double_click' && s.action !== 'scroll') continue
    const eventI = s.eventI != null ? s.eventI : s.i
    const f = byEvent.get(eventI)
    const meta = f?.click || f?.scroll
    if (!meta) continue
    s.hint = {
      ...(s.hint || {}),
      x: meta.screenX,
      y: meta.screenY,
      imageX: meta.imageX,
      imageY: meta.imageY,
      imageW: meta.imageW,
      imageH: meta.imageH,
      crop: meta.crop || null,
      button: meta.button || s.button || undefined,
      phase: meta.phase || s.phase || undefined,
      delta: meta.delta != null ? meta.delta : s.delta,
      frameFile: f.file,
      mapped: meta.mapped,
    }
  }
  return playbook
}

/** 给 digest 提示用的附图坐标说明（支持拼图格号）。 */
export function describeClickFramesForPrompt(images) {
  return describeDigestImagesForPrompt(images)
}

export async function readLearnedFrameManifest(home, learnedId) {
  try {
    const raw = await readFile(join(learnedFramesDir(home, learnedId), 'manifest.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function listLearnedFrameFiles(home, learnedId) {
  try {
    const dir = learnedFramesDir(home, learnedId)
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith('.png'))
  } catch {
    return []
  }
}
