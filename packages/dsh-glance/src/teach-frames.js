/**
 * 教学帧：每次点击必截一张并绑定图内坐标；少量上下文帧控量。
 * 图只供「学会」时喂模型；自动化执行不再带图。
 *
 * @module src/teach-frames.js
 */

import { mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFrame } from './capture.js'

/** 开场/换窗/收尾等上下文关键帧上限（不含点击帧） */
export const MAX_KEY_FRAMES = 5
export const MAX_SUPPLEMENT_FRAMES = 2
/** 点击帧软上限，防止极端连点撑爆磁盘/token */
export const MAX_CLICK_FRAMES = 40
/** @deprecated 旧合计上限；现点击帧单独预算 */
export const MAX_TOTAL_FRAMES = MAX_KEY_FRAMES + MAX_SUPPLEMENT_FRAMES + MAX_CLICK_FRAMES

export function teachFramesDir(home, sessionId) {
  return join(home, 'teach', `${sessionId}-frames`)
}

export function learnedFramesDir(home, learnedId) {
  return join(home, 'learned', learnedId, 'frames')
}

/**
 * 把屏幕坐标映射到抓屏 PNG 像素坐标（整屏抓取再按 max_width 缩放）。
 * @param {number} screenX
 * @param {number} screenY
 * @param {{ width?: number, height?: number, screen?: { w?: number, h?: number, width?: number, height?: number } }} shot
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
  // 无屏幕尺寸时只能把屏幕坐标当图坐标候选（模型仍可知点击落点）
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

  async function writePng(buf, file) {
    const dir = teachFramesDir(options.home, options.sessionId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, file)
    await writeFile(path, buf)
    return path
  }

  async function grabShot() {
    const sc = sidecar()
    const shot = await capture({
      quality: 'low',
      home: options.home,
      sidecar: sc,
      timeoutMs: 8_000,
    })
    if (!shot?.png?.byteLength) return null
    // capture 未带 screen 时，尽量从 sidecar hello 补全，便于坐标映射
    if (!shot.screen?.w && !shot.screen?.width && typeof sc?.getHello === 'function') {
      const helloScreen = sc.getHello()?.screen
      if (helloScreen) shot.screen = helloScreen
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
   * 每次点击必抓：截图 + 屏幕坐标映射到图内坐标。
   * @param {{
   *   eventI: number,
   *   x: number,
   *   y: number,
   *   button?: string,
   *   action?: string,
   *   window?: string | null,
   * }} info
   */
  async function snapOnClick(info) {
    if (clickCount() >= MAX_CLICK_FRAMES) {
      log(`teach-frame：点击帧已达上限 ${MAX_CLICK_FRAMES}`)
      return null
    }
    try {
      const shot = await grabShot()
      if (!shot) return null
      const mapped = mapScreenToImageCoords(info.x, info.y, shot)
      const i = seq
      seq += 1
      const action = String(info.action || 'click')
      const file = `${String(i).padStart(2, '0')}-click-step${info.eventI}.png`
      await writePng(shot.png, file)
      const win = info.window || shot.window?.title || shot.active?.title || null
      const click = {
        eventI: info.eventI,
        action,
        button: info.button || 'left',
        screenX: Number(info.x),
        screenY: Number(info.y),
        imageX: mapped.imageX,
        imageY: mapped.imageY,
        imageW: mapped.imageW,
        imageH: mapped.imageH,
        mapped: mapped.mapped,
      }
      const entry = {
        i,
        reason: 'click',
        role: 'click',
        file,
        window: win ? String(win).slice(0, 80) : null,
        at: new Date().toISOString(),
        bytes: shot.png.byteLength,
        imageW: mapped.imageW,
        imageH: mapped.imageH,
        click,
      }
      frames.push(entry)
      recent.push({ png: shot.png, entry })
      if (recent.length > 4) recent.shift()
      if (win) lastWindow = String(win)
      log(
        `teach-frame：click #${i} step${info.eventI} `
        + `screen(${click.screenX},${click.screenY})→img(${click.imageX},${click.imageY}) ${file}`,
      )
      return entry
    } catch (e) {
      log(`teach-frame 点击截图失败：${e?.message ?? e}`)
      return null
    }
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
    }
  }

  /**
   * 理解阶段优先喂点击帧（带坐标），再上下文/补图。
   * @param {number} [limit]
   */
  async function loadPngBuffers(limit = MAX_TOTAL_FRAMES) {
    const dir = teachFramesDir(options.home, options.sessionId)
    const ordered = [
      ...frames.filter((f) => f.role === 'click'),
      ...frames.filter((f) => f.role === 'key'),
      ...frames.filter((f) => f.role === 'supplement'),
    ].slice(0, limit)
    const out = []
    for (const f of ordered) {
      try {
        const png = await readFile(join(dir, f.file))
        out.push({ ...f, png, name: f.file })
      } catch { /* skip */ }
    }
    return out
  }

  return {
    snapStart,
    snapEnd,
    snapOnClick,
    maybeOnWindow,
    supplement,
    writeManifest,
    promoteToLearned,
    loadPngBuffers,
    list: () => frames.slice(),
    keyCount,
    clickCount,
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
    if (f.role === 'click' && f.click && f.click.eventI != null) {
      byEvent.set(f.click.eventI, f)
    }
  }
  for (const s of playbook?.steps || []) {
    if (s.action !== 'click' && s.action !== 'double_click') continue
    const eventI = s.eventI != null ? s.eventI : s.i
    const f = byEvent.get(eventI)
    if (!f?.click) continue
    s.hint = {
      ...(s.hint || {}),
      x: f.click.screenX,
      y: f.click.screenY,
      imageX: f.click.imageX,
      imageY: f.click.imageY,
      imageW: f.click.imageW,
      imageH: f.click.imageH,
      frameFile: f.file,
      mapped: f.click.mapped,
    }
  }
  return playbook
}

/** 给 digest 提示用的附图坐标说明。 */
export function describeClickFramesForPrompt(images) {
  const lines = []
  let n = 0
  for (const img of images || []) {
    n += 1
    if (img.role === 'click' && img.click) {
      const c = img.click
      const size = (c.imageW && c.imageH) ? `，图尺寸 ${c.imageW}×${c.imageH}` : ''
      const mapNote = c.mapped ? '图内坐标' : '坐标（未缩放映射，近似）'
      lines.push(
        `图${n}（${img.name || img.file}）：步骤#${c.eventI} ${c.action}`
        + ` 屏幕(${c.screenX},${c.screenY}) → ${mapNote}(${c.imageX},${c.imageY})${size}`
        + (img.window ? ` @「${String(img.window).slice(0, 40)}」` : ''),
      )
    } else {
      lines.push(`图${n}（${img.name || img.file}）：上下文/${img.reason || img.role}`)
    }
  }
  return lines.join('\n')
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
