/**
 * 插件入口：只做装配，不做业务。
 *
 * A2 装配：`GET /api/glance/status` + `glance` 工具 + Python sidecar 生命周期。
 * 抓屏在 `capture.js`，协议在 `sidecar.js` / `sidecar/glance.py`，这里只负责挂上去 / 拔干净。
 *
 * apply 失败一律返回空 disposer：最坏是插件不能用，不能让整个应用起不来。
 *
 * @module src/index.js
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rejectionFor } from './trust.js'
import { writeError } from './log.js'
import { createGlanceTool } from './tool-glance.js'
import { TOOL_NAME } from './tool-spec.js'
import { createSidecarManager } from './sidecar.js'

export const name = 'dsh-glance'

// `tools` / `attachments` 用 ctx.inject 按需拿（硬约束 5）：没有它们的部署只是少个工具。
export const inject = []

export const ROUTE_PREFIX = '/api/glance'
export const VERSION = '0.0.2'

const startedAt = Date.now()

/** 数据目录：`~/.dsh/glance/`。测试可以用 `DSH_GLANCE_HOME` 指到临时目录。 */
export function glanceHome() {
  return process.env.DSH_GLANCE_HOME || join(homedir(), '.dsh', 'glance')
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readConnection(scoped) {
  // 每次请求现取：`connection` 可能比本插件晚挂载，缓存一次就会永远是 undefined。
  try {
    return scoped.get('connection')
  } catch {
    return undefined
  }
}

async function handle(req, res, connection, log, state) {
  const rejection = rejectionFor(req, connection)
  if (rejection !== undefined) {
    log(`拒绝一个不受信任的请求：${rejection}`)
    send(res, rejection, { ok: false, rejected: ['请求不被信任'] })
    return
  }

  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    send(res, 400, { ok: false, rejected: ['请求路径无法解析'] })
    return
  }

  const route = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname
  const method = String(req.method ?? 'GET').toUpperCase()

  if (route === '/status') {
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { ok: false, rejected: ['只支持 GET'] })
      return
    }
    const sidecar = state.sidecar
    send(res, 200, {
      ok: true,
      name,
      version: VERSION,
      stage: 'A2',
      home: glanceHome(),
      uptimeMs: Date.now() - startedAt,
      tools: state.tools.slice(),
      sidecar: {
        alive: Boolean(sidecar?.isAlive?.()),
        pid: sidecar?.getPid?.() ?? null,
        hello: sidecar?.getHello?.() ?? null,
      },
    })
    return
  }

  send(res, 404, { ok: false, rejected: ['没有这条路由'] })
}

function installRoutes(ctx, log, state) {
  if (typeof ctx?.inject !== 'function') {
    log('宿主没有 ctx.inject，跳过 HTTP 接口')
    return
  }
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () => scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => handle(req, res, readConnection(scoped), log, state),
        }),
        'dsh-glance: routes',
      )
    })
  } catch (e) {
    log(`HTTP 接口没挂上：${e?.message ?? e}`)
  }
}

function installTools(ctx, log, state) {
  if (typeof ctx?.inject !== 'function') {
    log('宿主没有 ctx.inject，跳过工具')
    return
  }
  try {
    ctx.inject(['tools', 'attachments'], (scoped) => {
      let dispose
      let disposed = false

      scoped.effect(() => () => {
        disposed = true
        state.tools = state.tools.filter((n) => n !== TOOL_NAME)
        try { dispose?.() } catch { /* 已经摘过 */ }
      }, 'dsh-glance: glance tool')

      try {
        if (disposed) return
        dispose = scoped.tools.register(createGlanceTool({
          home: glanceHome(),
          attachments: scoped.attachments,
          log,
          sidecar: state.sidecar,
        }))
        state.tools.push(TOOL_NAME)
        log(`工具已注册：${TOOL_NAME}`)
      } catch (e) {
        writeError(e, 'glance-tool')
        log(`工具没挂上：${e?.message ?? e}`)
      }
    })
  } catch (e) {
    writeError(e, 'glance-tool')
    log(`工具没挂上：${e?.message ?? e}`)
  }
}

function installSidecar(ctx, log, state, disposers) {
  const manager = createSidecarManager({ log })
  state.sidecar = manager

  // 单测 / 无 Python 环境：设了就不拉进程，工具仍可挂上并退 PowerShell。
  if (process.env.DSH_GLANCE_NO_SIDECAR === '1') {
    log('DSH_GLANCE_NO_SIDECAR=1，跳过 sidecar')
    return
  }

  const startSafe = () => {
    manager.start().catch((e) => {
      // sidecar 起不来不致命：整屏还能走 PowerShell。
      log(`sidecar 未能启动：${e?.message ?? e}`)
    })
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      startSafe()
      return () => { void manager.stop() }
    }, 'dsh-glance: sidecar')
    return
  }

  startSafe()
  disposers.push(() => { void manager.stop() })
}

export async function apply(ctx) {
  const log = (m) => { try { ctx?.logger?.info?.(`[dsh-glance] ${m}`) } catch { /* 日志不该影响加载 */ } }
  const disposers = []
  const state = { tools: [], sidecar: null }

  try {
    const home = glanceHome()
    mkdirSync(join(home, 'episodes'), { recursive: true })
    log(`home: ${home}`)
    installSidecar(ctx, log, state, disposers)
    installRoutes(ctx, log, state)
    installTools(ctx, log, state)
  } catch (e) {
    writeError(e)
    log(`加载失败：${e?.message ?? e}`)
    for (const d of disposers.reverse()) { try { d() } catch { /* 收拾不干净也不能再抛 */ } }
    if (process.env.DSH_GLANCE_DEBUG) throw e
    return () => {}
  }

  return () => {
    for (const d of disposers.reverse()) { try { d() } catch { /* 同上 */ } }
  }
}
