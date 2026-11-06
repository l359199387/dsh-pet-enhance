/**
 * 教学关键帧：少量落盘，只供「学会」时喂模型；自动化执行不再带图。
 *
 * 预算：关键帧最多 5；若理解不够，可再补前后最多 2 张（总计 ≤7）。
 *
 * @module src/teach-frames.js
 */

import { mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFrame } from './capture.js'

export const MAX_KEY_FRAMES = 5
export const MAX_SUPPLEMENT_FRAMES = 2
export const MAX_TOTAL_FRAMES = MAX_KEY_FRAMES + MAX_SUPPLEMENT_FRAMES

export function teachFramesDir(home, sessionId) {
  return join(home, 'teach', `${sessionId}-frames`)
}

export function learnedFramesDir(home, learnedId) {
  return join(home, 'learned', learnedId, 'frames')
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
  /** @type {{ i: number, reason: string, role: string, file: string, window: string|null, at: string }[]} */
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

  async function writePng(buf, file) {
    const dir = teachFramesDir(options.home, options.sessionId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, file)
    await writeFile(path, buf)
    return path
  }

  /**
   * @param {string} reason start|window|end|mid|supplement-before|supplement-after
   * @param {'key'|'supplement'} role
   */
  async function snap(reason, role = 'key') {
    if (role === 'key' && keyCount() >= MAX_KEY_FRAMES) return null
    if (role === 'supplement' && supplementCount() >= MAX_SUPPLEMENT_FRAMES) return null
    if (frames.length >= MAX_TOTAL_FRAMES) return null

    try {
      const shot = await capture({
        quality: 'low',
        home: options.home,
        sidecar: sidecar(),
        timeoutMs: 8_000,
      })
      if (!shot?.png?.byteLength) return null

      const i = seq
      seq += 1
      const file = `${String(i).padStart(2, '0')}-${role}-${reason}.png`
      await writePng(shot.png, file)
      const win = shot.window?.title || shot.active?.title || null
      const entry = {
        i,
        reason,
        role,
        file,
        window: win ? String(win).slice(0, 80) : null,
        at: new Date().toISOString(),
        bytes: shot.png.byteLength,
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

  /** 窗口标题变化时抓关键帧（控量）。 */
  async function maybeOnWindow(title) {
    const t = String(title || '').trim()
    if (!t || t === lastWindow) return null
    lastWindow = t
    if (keyCount() >= MAX_KEY_FRAMES) return null
    // 留给 end 至少 1 个名额
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
      // 把倒数第二帧再落一条 supplement 记录（已在 frames 则跳过）
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
        }
        frames.push(entry)
        return entry
      }
    }
    return snap(which === 'before' ? 'supplement-before' : 'supplement-after', 'supplement')
  }

  async function writeManifest() {
    const dir = teachFramesDir(options.home, options.sessionId)
    await mkdir(dir, { recursive: true })
    const manifest = {
      sessionId: options.sessionId,
      maxKey: MAX_KEY_FRAMES,
      maxSupplement: MAX_SUPPLEMENT_FRAMES,
      frames: frames.map(({ i, reason, role, file, window, at, bytes }) => ({
        i, reason, role, file, window, at, bytes,
      })),
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
      note: '自动化执行不要加载这些图片',
    }, null, 2)}\n`, 'utf8')
    return { dir: destDir, count: frames.length, files: frames.map((f) => f.file) }
  }

  async function loadPngBuffers(limit = MAX_TOTAL_FRAMES) {
    const dir = teachFramesDir(options.home, options.sessionId)
    const out = []
    for (const f of frames.slice(0, limit)) {
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
    maybeOnWindow,
    supplement,
    writeManifest,
    promoteToLearned,
    loadPngBuffers,
    list: () => frames.slice(),
    keyCount,
    lastWindow: () => lastWindow,
  }
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
