/**
 * 抓屏通道：优先走常驻 Python sidecar；不可用时退回每次 spawn 一次 PowerShell。
 *
 * A1 的 PowerShell 路径保留作降级；窗口 / region / DPI 同进程坐标是 A2 sidecar 的事。
 *
 * @module src/capture.js
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 抓屏脚本的绝对路径。`files` 里必须含 `sidecar/`，否则装完这个文件不存在。 */
export const CAPTURE_SCRIPT = join(HERE, '..', 'sidecar', 'capture.ps1')

/**
 * 档位 → 画布宽度。与 03 §7 的 `low 798 / standard 1050 / high 1260` 一致
 * （宽度对齐 42 的倍数，图片 token 按 42px 一块算）。
 */
export const CANVAS_WIDTH = { low: 798, standard: 1050, high: 1260 }

export function canvasWidth(quality) {
  return CANVAS_WIDTH[quality] ?? CANVAS_WIDTH.low
}

/** 只认三个档位；其它（含 undefined）一律回 `low`，免得模型随手写个词就报错。 */
export function normalizeQuality(value) {
  const q = String(value ?? '').trim().toLowerCase()
  return Object.hasOwn(CANVAS_WIDTH, q) ? q : 'low'
}

/**
 * 降级路径用的 Windows PowerShell 5.1。PATH 上没有 `pwsh.exe`，这里必须是绝对路径。
 */
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** 跑一次 PowerShell，收集 stdout；超时或 abort 一律杀掉子进程。 */
function runPowerShell(argv, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('抓屏被取消'), { code: 'ABORTED' }))
      return
    }

    const child = spawn(POWERSHELL, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }

    const kill = (code) => {
      try { child.kill() } catch { /* 已经退了 */ }
      finish(reject, Object.assign(new Error(code === 'ABORTED' ? '抓屏被取消' : `抓屏超时（${timeoutMs}ms）`), { code }))
    }

    const onAbort = () => kill('ABORTED')
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const timer = setTimeout(() => kill('TIMEOUT'), timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', (e) => finish(reject, Object.assign(e, { code: 'SPAWN_FAILED' })))
    child.on('close', (code) => {
      finish(resolve, { code: code ?? -1, stdout, stderr })
    })
  })
}

/** PowerShell 的 stdout 可能带 BOM 或意外空行；取最后一行能解析成 JSON 的。 */
function parseResult(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim().replace(/^\uFEFF/, '')
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      continue
    }
  }
  return null
}

/**
 * 解析 `region`：`"x,y,w,h"` 或 `{x,y,w,h}`。非法则抛 BAD_REQUEST。
 */
export function parseRegion(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object') {
    const x = Number(value.x)
    const y = Number(value.y)
    const w = Number(value.w)
    const h = Number(value.h)
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      throw Object.assign(new Error('region 需要正数 x,y,w,h'), { code: 'BAD_REQUEST' })
    }
    return { x, y, w, h }
  }
  const parts = String(value).trim().split(/[,\s]+/).filter(Boolean)
  if (parts.length !== 4) {
    throw Object.assign(new Error('region 必须是 "x,y,w,h"'), { code: 'BAD_REQUEST' })
  }
  const [x, y, w, h] = parts.map(Number)
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    throw Object.assign(new Error('region 需要正数 x,y,w,h'), { code: 'BAD_REQUEST' })
  }
  return { x, y, w, h }
}

function withAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error('抓屏被取消'), { code: 'ABORTED' }))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('抓屏被取消'), { code: 'ABORTED' }))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/**
 * 经 sidecar 抓一帧。
 *
 * @param {{
 *   sidecar: { call: Function, isAlive?: Function },
 *   quality?: string,
 *   window?: string,
 *   region?: string | object,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 */
export async function captureViaSidecar({
  sidecar,
  quality,
  window,
  region,
  signal,
  timeoutMs = 30_000,
} = {}) {
  if (!sidecar || typeof sidecar.call !== 'function') {
    throw Object.assign(new Error('sidecar 不可用'), { code: 'SIDECAR_DOWN' })
  }

  const level = normalizeQuality(quality)
  const parsedRegion = parseRegion(region)
  const match = String(window ?? '').trim()

  /** @type {object} */
  let source
  if (match) {
    source = { kind: 'window', match }
  } else if (parsedRegion) {
    source = { kind: 'screen', region: parsedRegion }
  } else {
    source = { kind: 'screen' }
  }

  const resp = await withAbort(
    sidecar.call('capture', { source, max_width: canvasWidth(level) }, timeoutMs),
    signal,
  )

  if (!resp?.ok) {
    const err = resp?.error ?? {}
    throw Object.assign(new Error(err.message || '抓屏失败'), {
      code: err.code || 'CAPTURE_FAILED',
      candidates: err.candidates,
    })
  }

  const png = Buffer.from(String(resp.png || ''), 'base64')
  if (png.byteLength < 8 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw Object.assign(new Error('sidecar 回的不是 PNG'), { code: 'CAPTURE_FAILED' })
  }

  const helloScreen = sidecar.getHello?.()?.screen
  const rect = Array.isArray(resp.rect) && resp.rect.length >= 4
    ? resp.rect.map(Number)
    : (resp.capture && resp.capture.w != null
      ? [
        Number(resp.capture.x) || 0,
        Number(resp.capture.y) || 0,
        (Number(resp.capture.x) || 0) + (Number(resp.capture.w) || 0),
        (Number(resp.capture.y) || 0) + (Number(resp.capture.h) || 0),
      ]
      : null)
  return {
    png,
    width: Number(resp.w) || 0,
    height: Number(resp.h) || 0,
    screen: helloScreen ?? resp.active?.rect ?? {},
    monitors: [],
    quality: level,
    ms: Number(resp.ms) || 0,
    engine: 'sidecar',
    window: resp.window ?? null,
    active: resp.active ?? null,
    cursor: resp.cursor ?? null,
    rect,
    capture: resp.capture ?? null,
    candidates: undefined,
  }
}

/**
 * PowerShell 整屏降级路径（A1）。不支持 window。
 *
 * @param {{ quality?: string, home: string, signal?: AbortSignal, timeoutMs?: number }} options
 */
export async function captureScreenPowerShell({ quality, home, signal, timeoutMs = 20_000 } = {}) {
  const level = normalizeQuality(quality)
  const outDir = join(home, 'cache')
  await mkdir(outDir, { recursive: true })

  const { code, stdout, stderr } = await runPowerShell([
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', CAPTURE_SCRIPT,
    '-MaxWidth', String(canvasWidth(level)),
    '-OutDir', outDir,
  ], { signal, timeoutMs })

  const result = parseResult(stdout)
  if (!result) {
    const detail = String(stderr || stdout || '').trim().slice(0, 400)
    throw Object.assign(new Error(`PowerShell 没回结果（exit ${code}）：${detail || '无输出'}`), { code: 'CAPTURE_FAILED' })
  }
  if (!result.ok) {
    const err = result.error ?? {}
    throw Object.assign(new Error(err.message || '抓屏失败'), { code: err.code || 'CAPTURE_FAILED' })
  }

  let png
  try {
    png = await readFile(result.path)
  } finally {
    await unlink(result.path).catch(() => {})
  }

  return {
    png,
    width: Number(result.width) || 0,
    height: Number(result.height) || 0,
    screen: result.screen ?? {},
    monitors: Array.isArray(result.monitors) ? result.monitors : [],
    quality: level,
    ms: Number(result.ms) || 0,
    engine: 'powershell',
    window: null,
    active: null,
    cursor: null,
  }
}

/**
 * 统一入口：有 sidecar 且活着 → 走 sidecar；否则整屏可退 PowerShell，窗口则直接失败。
 */
export async function captureFrame({
  sidecar,
  quality,
  window,
  region,
  home,
  signal,
  timeoutMs,
} = {}) {
  const match = String(window ?? '').trim()
  const wantsWindow = Boolean(match)
  const wantsRegion = region != null && region !== ''

  if (sidecar) {
    try {
      return await captureViaSidecar({ sidecar, quality, window, region, signal, timeoutMs })
    } catch (error) {
      // 窗口/区域失败不能静默改抓整屏——那会让模型以为看到了目标窗口。
      if (wantsWindow || wantsRegion) throw error
      if (error?.code === 'WINDOW_NOT_FOUND' || error?.code === 'WINDOW_AMBIGUOUS') throw error
      // sidecar 挂了才退 PowerShell。
      if (!['SIDECAR_DOWN', 'SIDECAR_EXIT', 'NO_PYTHON', 'NO_SCRIPT', 'NO_PIL', 'HANDSHAKE_FAILED', 'TIMEOUT'].includes(error?.code)) {
        throw error
      }
    }
  }

  if (wantsWindow) {
    throw Object.assign(new Error('单窗口抓取需要 Python sidecar，当前不可用'), { code: 'SIDECAR_DOWN' })
  }
  if (wantsRegion) {
    throw Object.assign(new Error('区域抓取需要 Python sidecar，当前不可用'), { code: 'SIDECAR_DOWN' })
  }

  return captureScreenPowerShell({ quality, home, signal, timeoutMs })
}

/** @deprecated 用 captureFrame；保留别名以免旧测试立刻挂。 */
export async function captureScreen(options) {
  return captureFrame(options)
}
