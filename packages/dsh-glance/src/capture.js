/**
 * A1 的抓屏通道：每次调用起一个 `powershell.exe` 跑 `sidecar/capture.ps1`。
 *
 * 为什么是「每次 spawn」而不是常驻进程：A1 只要一张整屏图，先证明
 * 「图能从宿主的工具结果里出来」这条链路。常驻 sidecar（握手、退避重建、
 * 窗口抓取、输入注入）是 A2 的事，到那时抓屏和输入必须同进程共享 DPI，
 * 这里这种一次性调用的坐标系就不再被使用。
 *
 * 纪律：子进程由本次调用拥有，超时或 `exec.signal` 一 abort 立刻杀掉，
 * 不留在后台；因此它不是硬约束 4 说的那种「裸 spawn 常驻服务」。
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
 * 抓一张整屏图。
 *
 * @param {{ quality?: string, home: string, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{png: Buffer, width: number, height: number, screen: object, monitors: object[], quality: string, ms: number}>}
 */
export async function captureScreen({ quality, home, signal, timeoutMs = 20_000 } = {}) {
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
    // 图已经进内存，临时文件不留：一次一张，攒着只会让 cache 目录失控。
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
  }
}
