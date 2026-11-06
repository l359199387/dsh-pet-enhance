/**
 * 插件入口：只做装配，不做业务。
 *
 * A1 装配两件事：`GET /api/glance/status`（证明起来了）+ `glance` 工具（证明图能交给模型）。
 * 抓屏本身在 `capture.js`，工具契约在 `tool-spec.js`，这里只负责「挂上去 / 拔干净」。
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
import { loadDefineTool } from './define.js'
import { TOOL_NAME } from './tool-spec.js'

export const name = 'dsh-glance'

// `tools` / `attachments` 用 ctx.inject 按需拿（硬约束 5）：没有它们的部署只是少个工具。
export const inject = []

export const ROUTE_PREFIX = '/api/glance'
export const VERSION = '0.0.1'

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
  // 前缀路由不经内核准入，第一件事永远是过自己的闸门。
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
    send(res, 200, {
      ok: true,
      name,
      version: VERSION,
      stage: 'A1',
      home: glanceHome(),
      uptimeMs: Date.now() - startedAt,
      tools: state.tools.slice(),
    })
    return
  }

  send(res, 404, { ok: false, rejected: ['没有这条路由'] })
}

function installRoutes(ctx, log, state) {
  // `webServer` 刻意不写进 `inject`：它是可选能力，写进去会让没有它的部署连插件都起不来。
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
    // 面板/状态接口是附加能力，挂不上最多少一条路由，不该影响插件本体。
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

      // 工具注册也归 effect 拥有（硬约束 4）。这里住的是「卸插件时把工具摘掉」，
      // 而注册本身是异步的（要等 import），所以用 disposed 标记兜住「还没挂上就被拔」。
      scoped.effect(() => () => {
        disposed = true
        state.tools = state.tools.filter((n) => n !== TOOL_NAME)
        try { dispose?.() } catch { /* 已经摘过 */ }
      }, 'dsh-glance: glance tool')

      void (async () => {
        try {
          const defineTool = await loadDefineTool()
          if (disposed) return
          const tool = createGlanceTool({
            defineTool,
            home: glanceHome(),
            attachments: scoped.attachments,
            log,
          })
          dispose = scoped.tools.register(tool)
          state.tools.push(TOOL_NAME)
          log(`工具已注册：${TOOL_NAME}`)
        } catch (e) {
          writeError(e, 'glance-tool')
          log(`工具没挂上：${e?.message ?? e}`)
        }
      })()
    })
  } catch (e) {
    writeError(e, 'glance-tool')
    log(`工具没挂上：${e?.message ?? e}`)
  }
}

export async function apply(ctx) {
  const log = (m) => { try { ctx?.logger?.info?.(`[dsh-glance] ${m}`) } catch { /* 日志不该影响加载 */ } }
  const disposers = []
  const state = { tools: [] }

  try {
    const home = glanceHome()
    mkdirSync(join(home, 'episodes'), { recursive: true })
    log(`home: ${home}`)
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
