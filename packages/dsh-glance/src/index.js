/**
 * 插件入口：只做装配，不做业务。
 *
 * B2 装配：A2/B1 + dsh-pet L 对话看屏闭环 + episode 落盘 + 附图人格。
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
import { createGlanceState, normalizePetState } from './state.js'
import {
  clearGlanceMenu,
  callDshPet,
  MENU_OWNER,
  MENU_STOP,
  probeDshPet,
  registerGlanceMenu,
  resolveDshOrigin,
  setDshPetBaseUrl,
} from './dsh-pet.js'
import { createChatBridge } from './chat-bridge.js'

export const name = 'dsh-glance'

export const inject = []

export const ROUTE_PREFIX = '/api/glance'
export const VERSION = '0.0.4'

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
  try {
    return scoped.get('connection')
  } catch {
    return undefined
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'PAYLOAD_TOO_LARGE' }))
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function refreshActiveWindow(state) {
  const sidecar = state.sidecar
  if (!sidecar?.isAlive?.()) return
  const now = Date.now()
  if (state._windowAt && now - state._windowAt < 900) return
  state._windowAt = now
  try {
    const stats = await sidecar.call('stats', {}, 2_000)
    if (stats?.ok) state.glance.setWindow(stats.active ?? null)
  } catch {
    // 轮询失败不致命
  }
}

async function refreshDshPet(state) {
  const now = Date.now()
  if (state._dshPetAt && now - state._dshPetAt < 5_000) return state._dshPet
  state._dshPetAt = now
  const probed = await probeDshPet({ timeoutMs: 1_200 })
  state._dshPet = {
    available: probed.available,
    pets: probed.pets ?? [],
    error: probed.error,
  }
  return state._dshPet
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
    const dshPet = await refreshDshPet(state)
    send(res, 200, {
      ok: true,
      name,
      version: VERSION,
      stage: 'B2',
      home: glanceHome(),
      uptimeMs: Date.now() - startedAt,
      tools: state.tools.slice(),
      sidecar: {
        alive: Boolean(sidecar?.isAlive?.()),
        pid: sidecar?.getPid?.() ?? null,
        hello: sidecar?.getHello?.() ?? null,
      },
      pet: state.glance.snapshot().pet.state.data,
      dshPet,
    })
    return
  }

  if (route === '/state') {
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { ok: false, rejected: ['只支持 GET'] })
      return
    }
    await refreshActiveWindow(state)
    const dshPet = await refreshDshPet(state)
    send(res, 200, { ...state.glance.snapshot(), dshPet })
    return
  }

  if (route === '/stop') {
    if (method !== 'POST') {
      send(res, 405, { ok: false, rejected: ['只支持 POST'] })
      return
    }
    state.glance.panic()
    // A2/B1 还没有动作队列；C1 起这里再 abort sidecar input。
    log('用户急停')
    send(res, 200, { ok: true, pet: 'alarmed' })
    return
  }

  if (route === '/pet') {
    if (method !== 'POST') {
      send(res, 405, { ok: false, rejected: ['只支持 POST'] })
      return
    }
    let raw
    try {
      raw = await readBody(req)
    } catch (e) {
      send(res, e?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { ok: false, rejected: [String(e?.message ?? e)] })
      return
    }
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      send(res, 400, { ok: false, rejected: ['JSON 无法解析'] })
      return
    }
    const next = normalizePetState(body?.state)
    // 客户端只能设 idle / sleeping；干活态由 Host 工具管线写。
    if (next !== 'idle' && next !== 'sleeping' && next !== 'alarmed') {
      send(res, 400, { ok: false, rejected: ['客户端只能设 idle / sleeping / alarmed'] })
      return
    }
    state.glance.setPet(next)
    if (next === 'idle') state.glance.setArmed(true)
    send(res, 200, { ok: true, pet: next })
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
          onLooking: () => state.glance.setPet('looking'),
          onIdle: () => {
            if (state.glance.snapshot().pet.state.data === 'looking') {
              state.glance.setPet('idle')
            }
          },
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

function installDshPetBridge(ctx, log, state, disposers) {
  const run = (origin) => {
    if (!origin) {
      log('dsh-pet bridge：拿不到 DSH origin，跳过（Host 不能用相对路径 fetch）')
      return () => {}
    }
    setDshPetBaseUrl(origin)
    log(`dsh-pet bridge origin=${origin}`)

    let stopped = false
    let registered = false
    const bridge = createChatBridge({
      home: glanceHome(),
      sidecar: () => state.sidecar,
      log,
      onLooking: () => state.glance.setPet('looking'),
      onIdle: () => {
        if (state.glance.snapshot().pet.state.data === 'looking') {
          state.glance.setPet('idle')
        }
      },
    })

    const ensureMenu = async () => {
      if (stopped) return
      const probed = await probeDshPet({ timeoutMs: 1_200 })
      if (!probed.available) {
        registered = false
        return
      }
      if (!registered) {
        const r = await registerGlanceMenu()
        if (r.ok) {
          registered = true
          log('已在 dsh-pet 菜单挂上「小蓝鲸急停」；对话请悬停宠物按 L，说「看一眼屏幕」')
        } else {
          log(`挂菜单失败：${r.error || r.status || JSON.stringify(r.data)}`)
        }
      }
    }

    const pollMenu = async () => {
      if (stopped || !registered) return
      const r = await callDshPet(
        `/menu/events?owner=${encodeURIComponent(MENU_OWNER)}&wait=0`,
        { method: 'GET', timeoutMs: 3_000 },
      )
      if (!r.ok || !r.data?.ok || !r.data.events) return
      if (r.data.events[MENU_STOP]) {
        state.glance.panic()
        log('dsh-pet 菜单触发小蓝鲸急停')
      }
    }

    bridge.start()
    ensureMenu().catch(() => {})
    const timer = setInterval(() => {
      ensureMenu().catch(() => {})
      pollMenu().catch(() => {})
    }, 4_000)
    return () => {
      stopped = true
      clearInterval(timer)
      bridge.stop()
      if (registered) clearGlanceMenu().catch(() => {})
    }
  }

  // Host 侧必须经 webServer 拿绝对 origin；没有 inject 时（单测）允许空跑。
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        if (typeof scoped?.effect === 'function') {
          scoped.effect(() => run(resolveDshOrigin(scoped.webServer)), 'dsh-glance: dsh-pet bridge')
          return
        }
        disposers.push(run(resolveDshOrigin(scoped.webServer)))
      })
      return
    } catch (e) {
      log(`dsh-pet bridge 没挂上：${e?.message ?? e}`)
      return
    }
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => run(resolveDshOrigin(ctx.webServer)), 'dsh-glance: dsh-pet bridge')
    return
  }
  disposers.push(run(resolveDshOrigin(ctx?.webServer)))
}

function installSidecar(ctx, log, state, disposers) {
  const manager = createSidecarManager({ log })
  state.sidecar = manager

  if (process.env.DSH_GLANCE_NO_SIDECAR === '1') {
    log('DSH_GLANCE_NO_SIDECAR=1，跳过 sidecar')
    return
  }

  const startSafe = () => {
    manager.start().catch((e) => {
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
  const state = {
    tools: [],
    sidecar: null,
    glance: createGlanceState(),
    _windowAt: 0,
    _dshPetAt: 0,
    _dshPet: { available: false, pets: [] },
  }

  try {
    const home = glanceHome()
    mkdirSync(join(home, 'episodes'), { recursive: true })
    log(`home: ${home}`)
    installSidecar(ctx, log, state, disposers)
    installDshPetBridge(ctx, log, state, disposers)
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
