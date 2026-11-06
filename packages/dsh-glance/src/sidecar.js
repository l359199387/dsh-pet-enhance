/**
 * Python sidecar 进程管理：JSON Lines 协议 + 握手 + 退出重建 + 指数退避。
 *
 * 抓屏与（C1 起）输入必须同进程共享 DPI；本文件只编排进程与请求，不碰像素。
 * 生命周期必须归 `ctx.effect` / apply disposer 拥有（硬约束 4），拔插件时停干净。
 *
 * @module src/sidecar.js
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SIDECAR_SCRIPT = join(HERE, '..', 'sidecar', 'glance.py')

const DEFAULT_PYTHON = join(
  homedir(),
  '.dsh',
  'dsh-runtimes',
  'dsh-primary-runtime',
  'dependencies',
  'python',
  'python.exe',
)

const HANDSHAKE_MS = 5_000
const REQUEST_MS = 30_000
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
const MAX_FAILS = 5
const STOP_GRACE_MS = 3_000

/** 找一个能跑 sidecar 的 Python；都没有就返回 null（上层退 PowerShell）。 */
export function resolvePython() {
  const candidates = [
    process.env.DSH_GLANCE_PYTHON,
    process.env.DSH_PYTHON,
    DEFAULT_PYTHON,
    process.platform === 'win32' ? 'python.exe' : 'python3',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    return candidate
  }
  return null
}

function nextId(state) {
  state.seq += 1
  return state.seq
}

/**
 * @param {{
 *   python?: string | null,
 *   script?: string,
 *   log?: (message: string) => void,
 *   onState?: (state: object) => void,
 * }} [options]
 */
export function createSidecarManager(options = {}) {
  const log = options.log ?? (() => {})
  const script = options.script ?? SIDECAR_SCRIPT
  const state = {
    seq: 0,
    child: null,
    buffer: '',
    pending: new Map(),
    hello: null,
    starting: null,
    stopped: false,
    fails: 0,
    restartTimer: null,
    pid: null,
    lastError: null,
  }

  function publish() {
    options.onState?.({
      alive: Boolean(state.child && !state.child.killed),
      pid: state.pid,
      hello: state.hello,
      fails: state.fails,
      lastError: state.lastError,
      pending: state.pending.size,
    })
  }

  function rejectAll(error) {
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    state.pending.clear()
  }

  function settleLine(line) {
    const text = line.trim().replace(/^\uFEFF/, '')
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch (e) {
      log(`sidecar 回了无法解析的行：${text.slice(0, 120)}`)
      return
    }
    const id = msg?.id
    if (id == null) return
    const entry = state.pending.get(id)
    if (!entry) return
    state.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(msg)
  }

  function onStdout(chunk) {
    state.buffer += chunk
    let idx
    while ((idx = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, idx)
      state.buffer = state.buffer.slice(idx + 1)
      settleLine(line)
    }
  }

  function scheduleRestart() {
    if (state.stopped) return
    if (state.fails >= MAX_FAILS) {
      state.lastError = `sidecar 连续失败 ${state.fails} 次，停止重建`
      log(state.lastError)
      publish()
      return
    }
    const delay = BACKOFF_MS[Math.min(state.fails, BACKOFF_MS.length - 1)]
    log(`sidecar 将在 ${delay}ms 后重建（fails=${state.fails}）`)
    clearTimeout(state.restartTimer)
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null
      if (!state.stopped) start().catch(() => {})
    }, delay)
  }

  function attach(child) {
    state.child = child
    state.pid = child.pid ?? null
    state.buffer = ''
    publish()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onStdout)
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log(`sidecar stderr: ${text.slice(0, 400)}`)
    })
    child.on('error', (e) => {
      state.lastError = e?.message ?? String(e)
      log(`sidecar spawn 失败：${state.lastError}`)
    })
    child.on('close', (code, signal) => {
      state.child = null
      state.pid = null
      state.hello = null
      const err = Object.assign(
        new Error(`sidecar 已退出（code=${code}, signal=${signal ?? ''}）`),
        { code: 'SIDECAR_EXIT' },
      )
      rejectAll(err)
      publish()
      if (!state.stopped) {
        state.fails += 1
        scheduleRestart()
      }
    })
  }

  function request(op, fields = {}, timeoutMs = REQUEST_MS) {
    return new Promise((resolve, reject) => {
      const child = state.child
      if (!child?.stdin || child.killed) {
        reject(Object.assign(new Error('sidecar 未就绪'), { code: 'SIDECAR_DOWN' }))
        return
      }
      const id = nextId(state)
      const payload = { id, op, ...fields }
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(Object.assign(new Error(`sidecar ${op} 超时（${timeoutMs}ms）`), { code: 'TIMEOUT' }))
      }, timeoutMs)
      state.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8')
      } catch (e) {
        state.pending.delete(id)
        clearTimeout(timer)
        reject(Object.assign(e, { code: 'SIDECAR_DOWN' }))
      }
    })
  }

  async function start() {
    if (state.stopped) return null
    if (state.hello) return state.hello
    if (state.starting) return state.starting

    state.starting = (async () => {
      const python = options.python === undefined ? resolvePython() : options.python
      if (!python) {
        state.lastError = '找不到 Python'
        publish()
        throw Object.assign(new Error(state.lastError), { code: 'NO_PYTHON' })
      }
      if (!existsSync(script)) {
        state.lastError = `找不到 sidecar 脚本：${script}`
        publish()
        throw Object.assign(new Error(state.lastError), { code: 'NO_SCRIPT' })
      }

      if (state.child) {
        try { state.child.kill() } catch { /* 已退 */ }
        state.child = null
      }

      const child = spawn(python, [script], {
        cwd: dirname(script),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      attach(child)

      try {
        const hello = await request('hello', {}, HANDSHAKE_MS)
        if (!hello?.ok) {
          const code = hello?.error?.code || 'HANDSHAKE_FAILED'
          throw Object.assign(new Error(hello?.error?.message || 'hello 失败'), { code })
        }
        state.hello = hello
        state.fails = 0
        state.lastError = null
        log(`sidecar 就绪 pid=${state.pid} screen=${hello.screen?.w}x${hello.screen?.h}`)
        publish()
        return hello
      } catch (e) {
        state.lastError = e?.message ?? String(e)
        try { child.kill() } catch { /* ignore */ }
        throw e
      } finally {
        state.starting = null
      }
    })()

    return state.starting
  }

  async function ensure() {
    if (state.stopped) {
      throw Object.assign(new Error('sidecar 已停止'), { code: 'SIDECAR_DOWN' })
    }
    if (state.hello && state.child) return state.hello
    return start()
  }

  async function call(op, fields = {}, timeoutMs = REQUEST_MS) {
    await ensure()
    return request(op, fields, timeoutMs)
  }

  function stop() {
    state.stopped = true
    clearTimeout(state.restartTimer)
    state.restartTimer = null
    const child = state.child
    rejectAll(Object.assign(new Error('sidecar 已停止'), { code: 'SIDECAR_DOWN' }))
    if (!child) {
      state.hello = null
      state.pid = null
      publish()
      return Promise.resolve()
    }
    // 先礼后兵：试着 quit，最多等 STOP_GRACE_MS，到点硬杀。disposer 不能假设会 await。
    try {
      const id = nextId(state)
      child.stdin?.write(`${JSON.stringify({ id, op: 'quit' })}\n`, 'utf8')
    } catch { /* 管道可能已断 */ }

    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        state.child = null
        state.pid = null
        state.hello = null
        publish()
        resolve()
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish()
      }, STOP_GRACE_MS)
      child.once('close', finish)
    })
  }

  /** 急停：打断正在执行的 input（读线程会立刻置位）。 */
  async function abort(timeoutMs = 3_000) {
    if (!state.child?.stdin || state.child.killed) {
      return { ok: false, error: 'sidecar-down' }
    }
    try {
      return await request('abort', {}, timeoutMs)
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  return {
    start,
    ensure,
    call,
    abort,
    stop,
    /** 测试/status 用：当前是否握过手。 */
    getHello: () => state.hello,
    getPid: () => state.pid,
    isAlive: () => Boolean(state.child && state.hello),
  }
}
