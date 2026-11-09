/**
 * 插件入口：只做装配，不做业务。
 *
 * C2 装配：看屏 + dsh-pet 桥 + L→主会话干活 + act（策略/确认/审计/急停）。
 *
 * apply 失败一律返回空 disposer：最坏是插件不能用，不能让整个应用起不来。
 *
 * @module src/index.js
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rejectionFor } from './trust.js'
import { writeError } from './log.js'
import { createGlanceTool } from './tool-glance.js'
import { createWakeBudget } from './watch-loop.js'
import { createActTool, ACT_TOOL_NAME } from './tool-act.js'
import { TOOL_NAME } from './tool-spec.js'
import { createSidecarManager } from './sidecar.js'
import { createGlanceState, normalizePetState } from './state.js'
import {
  broadcastToDshPet,
  clearGlanceMenu,
  callDshPet,
  MENU_OWNER,
  probeDshPet,
  registerGlanceMenu,
  resolveDshOrigin,
  setDshPetBaseUrl,
} from './dsh-pet.js'
import { sayConclusionToPet } from './pet-chat-memory.js'
import { createChatBridge } from './chat-bridge.js'
import { createAgentBridge } from './agent-bridge.js'
import { createLiveWatch } from './live-watch.js'
import { createTeachBridge } from './teach-bridge.js'
import { createPetRouter } from './pet-router.js'
import { getLocale, isActEnabled, loadSettings, saveSettings } from './settings.js'
import { localeTables, menuLabelVariants, t } from './i18n.js'
import { openRecentChat } from './recent-chat.js'
import { applyDshPetClickPatches } from './patch-dsh-pet-click.js'
import { applyDshPetConfirmPatches } from './patch-dsh-pet-confirm.js'
import { applyDshPetChatGatePatches } from './patch-dsh-pet-chat-gate.js'
import { applyDshPetChatClientPatches } from './patch-dsh-pet-chat-client.js'
import { runChatGate } from './chat-gate.js'
import { writeHostOrigin } from './host-origin.js'
import { ensureDesktopToken, tokenMatches } from './desktop-token.js'
import { createActionBudget } from './policy.js'
import { c3BudgetExceededBubble } from './c3-task.js'
import { createConfirmGate } from './confirm.js'
import { cancelAgentSession } from './wake-session.js'
import { openNewWorkspaceSession } from './session-spawn.js'
import {
  deleteLearnedPair,
  getLearnedDetail,
  listLearnedDetails,
  rateLearnedRun,
  updateLearnedPair,
} from './learned-manage.js'

export const name = 'dsh-pet-enhance'

export const inject = []

export const ROUTE_PREFIX = '/api/pet-enhance'
export const VERSION = '0.3.0'

const startedAt = Date.now()

/**
 * 数据目录：`~/.dsh/pet-enhance/`。
 * 环境变量：`DSH_PET_ENHANCE_HOME`（兼容旧名 `DSH_GLANCE_HOME`）。
 * 若仅有旧目录 `~/.dsh/glance`，启动时会尝试一次性迁到 `pet-enhance`。
 */
export function enhanceHome() {
  if (process.env.DSH_PET_ENHANCE_HOME) return process.env.DSH_PET_ENHANCE_HOME
  if (process.env.DSH_GLANCE_HOME) return process.env.DSH_GLANCE_HOME
  const next = join(homedir(), '.dsh', 'pet-enhance')
  const legacy = join(homedir(), '.dsh', 'glance')
  try {
    if (!existsSync(next) && existsSync(legacy)) {
      renameSync(legacy, next)
    }
  } catch {
    if (existsSync(legacy) && !existsSync(next)) return legacy
  }
  return next
}

/** @deprecated 用 enhanceHome；保留别名避免旧测试/脚本断裂 */
export function glanceHome() {
  return enhanceHome()
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

/**
 * 急停：停动手 + 取消主会话当前 turn（agent.cancel）。
 * @param {object} state
 * @param {(m: string) => void} log
 * @param {string} via
 */
async function runUserPanic(state, log, via = 'panic') {
  state.confirmGate?.cancelAll('panic')
  state.budget?.reset()
  state.rememberedConfirms?.clear()
  state.glance.panic()
  try {
    await state.sidecar?.abort?.()
  } catch (e) {
    log(`急停 abort sidecar 失败：${e?.message ?? e}`)
  }

  let agentCanceled = false
  try {
    const ctx = state.hostCtx || state.chatGateCtx || {}
    const cancel = await cancelAgentSession(ctx, {
      sessionId: state.lastAgentSessionId || state.lastSessionId,
      preferredId: state.lastSessionId,
      cause: { kind: 'user' },
    })
    agentCanceled = Boolean(cancel.ok && cancel.canceled)
    log(
      `急停（${via}）：agent ${agentCanceled ? `已 cancel ${cancel.sessionId}` : `未 cancel（${cancel.reason || 'n/a'}）`}`,
    )
  } catch (e) {
    log(`急停 cancel agent 失败：${e?.message ?? e}`)
  }

  try {
    await broadcastToDshPet(
      agentCanceled
        ? '已急停：动手和主会话这轮都停了。要继续再说一声。'
        : '已急停：动手已停。主会话若还在跑，可在会话里再点一次停止。',
      { duration: 10_000 },
    )
  } catch { /* ignore */ }

  return { agentCanceled }
}

async function handle(req, res, connection, log, state) {
  const rejection = rejectionFor(req, connection)
  const hdr = req?.headers || {}
  const desktopOk = tokenMatches(
    enhanceHome(),
    hdr['x-pet-enhance-token'] || hdr['x-glance-token'],
  )
  if (rejection !== undefined && !desktopOk) {
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

  if (route === '/i18n') {
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { ok: false, rejected: ['只支持 GET'] })
      return
    }
    const locale = getLocale(enhanceHome())
    send(res, 200, {
      ok: true,
      locale,
      tables: localeTables(),
    })
    return
  }

  if (route === '/chat-gate') {
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
    const text = String(body?.text ?? '').trim()
    if (!text) {
      send(res, 200, { ok: true, takeover: false, label: 'chat' })
      return
    }
    // 用户开口 → 清零 watch 叫醒预算（即使本条不接管）
    try { state.glanceTool?.noteUserTurn?.() } catch { /* ignore */ }
    if (!state.chatGateReady) {
      // 桥未就绪：不接管，避免丢消息
      send(res, 200, { ok: true, takeover: false, label: 'chat', via: 'bridge-not-ready' })
      return
    }
    try {
      const result = await runChatGate({
        ctx: state.chatGateCtx || {},
        home: glanceHome(),
        text,
        log,
        chatBridge: state.chatBridge,
        agentBridge: state.agentBridge,
        teachBridge: state.teachBridge,
        getPreferredSessionId: () => state.lastSessionId,
        openNewSession: () => openOwnerWorkspaceSession(state, log),
        markHandled: (content) => {
          state.chatGateHandled = { content: String(content), at: Date.now() }
        },
        isDuplicate: (content) => {
          const h = state.chatGateHandled
          if (!h?.content || h.content !== String(content)) return false
          return Date.now() - Number(h.at || 0) < 15_000
        },
      })
      send(res, 200, result)
    } catch (e) {
      log(`chat-gate 失败：${e?.message ?? e}`)
      send(res, 200, { ok: true, takeover: false, label: 'chat', via: 'error' })
    }
    return
  }

  if (route === '/settings') {
    if (method === 'GET' || method === 'HEAD') {
      const settings = await loadSettings(enhanceHome())
      send(res, 200, { ok: true, settings })
      return
    }
    if (method === 'PATCH') {
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
      const patch = {}
      if (body.locale != null) patch.locale = body.locale
      if (body.liveWatch != null) patch.liveWatch = body.liveWatch
      if (body.actEnabled != null) patch.actEnabled = body.actEnabled
      const settings = await saveSettings(enhanceHome(), patch)
      try {
        state.onLocaleChange?.(settings.locale)
      } catch { /* ignore */ }
      send(res, 200, { ok: true, settings })
      return
    }
    send(res, 405, { ok: false, rejected: ['只支持 GET / PATCH'] })
    return
  }

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
      stage: 'C2',
      actEnabled: isActEnabled(glanceHome()),
      lastSessionId: state.lastSessionId,
      home: glanceHome(),
      uptimeMs: Date.now() - startedAt,
      tools: state.tools.slice(),
      budget: {
        count: state.budget?.count ?? 0,
        max: state.budget?.max ?? 20,
      },
      pendingConfirm: state.glance.snapshot().guard.pendingConfirm.data,
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
    const panic = await runUserPanic(state, log, 'http')
    send(res, 200, {
      ok: true,
      pet: 'alarmed',
      armed: false,
      aborted: true,
      agentCanceled: Boolean(panic?.agentCanceled),
    })
    return
  }

  if (route === '/confirm') {
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
    const id = body?.id != null ? String(body.id) : ''
    if (!id) {
      send(res, 400, { ok: false, rejected: ['缺少 id'] })
      return
    }
    if (typeof body.allow !== 'boolean') {
      send(res, 400, { ok: false, rejected: ['allow 必须是 boolean'] })
      return
    }
    const ok = Boolean(state.confirmGate?.resolve(id, body.allow))
    if (!ok) {
      send(res, 409, { ok: false, rejected: ['没有这条待确认，或已过期'] })
      return
    }
    log(`确认回执 id=${id} allow=${body.allow}`)
    send(res, 200, { ok: true, id, allow: body.allow })
    return
  }

  if (route === '/teach-end') {
    if (method !== 'POST') {
      send(res, 405, { ok: false, rejected: ['只支持 POST'] })
      return
    }
    if (!state.teachBridge?.isTeaching?.()) {
      send(res, 409, { ok: false, rejected: ['现在不在教学模式'] })
      return
    }
    state.glance.setTeachEndOffer(false)
    log('带教结束：兼容旧 /teach-end（视为做成了）')
    Promise.resolve()
      .then(() => state.teachBridge.handleCoachUtterance?.('做成了，可以记下来')
        || state.teachBridge.stopAndRun())
      .catch((e) => log(`teach-end 失败：${e?.message ?? e}`))
    send(res, 200, { ok: true, ending: true })
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

  // —— 我学会的 ——
  if (route === '/learned') {
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { ok: false, rejected: ['只支持 GET'] })
      return
    }
    const items = await listLearnedDetails(glanceHome())
    send(res, 200, { ok: true, items })
    return
  }

  const learnedRateMatch = route.match(/^\/learned\/([^/]+)\/runs\/([^/]+)\/rate$/)
  if (learnedRateMatch) {
    const id = decodeURIComponent(learnedRateMatch[1])
    const runId = decodeURIComponent(learnedRateMatch[2])
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
    const r = await rateLearnedRun(glanceHome(), id, runId, {
      rating: body.rating,
      comment: body.comment,
    }, {
      ctx: state.hostCtx || state.chatGateCtx || {},
      log,
      preferredSessionId: state.lastSessionId || null,
    })
    if (!r.ok) {
      const code = r.reason === 'not-found' || r.reason === 'run-not-found' ? 404 : 400
      send(res, code, { ok: false, rejected: [r.reason || '评价失败'] })
      return
    }
    send(res, 200, {
      ok: true,
      item: r.detail,
      merged: Boolean(r.merged),
      mergeReason: r.mergeReason || null,
      rating: r.rating,
    })
    return
  }

  const learnedMatch = route.match(/^\/learned\/([^/]+)$/)
  if (learnedMatch) {
    const id = decodeURIComponent(learnedMatch[1])
    if (method === 'GET' || method === 'HEAD') {
      const detail = await getLearnedDetail(glanceHome(), id)
      if (!detail) {
        send(res, 404, { ok: false, rejected: ['找不到这条学会记录'] })
        return
      }
      send(res, 200, { ok: true, item: detail })
      return
    }
    if (method === 'PATCH') {
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
      const patch = {}
      if (body.goal != null) patch.goal = body.goal
      if (body.ownerNotes != null) patch.ownerNotes = body.ownerNotes
      const r = await updateLearnedPair(glanceHome(), id, patch, {
        ctx: state.hostCtx || state.chatGateCtx || {},
        log,
        preferredSessionId: state.lastSessionId || null,
        mergeNotes: body.mergeNotes !== false,
      })
      if (!r.ok) {
        send(res, r.reason === 'not-found' ? 404 : 400, { ok: false, rejected: [r.reason || '更新失败'] })
        return
      }
      send(res, 200, {
        ok: true,
        item: r.detail,
        merged: Boolean(r.merged),
        mergeReason: r.mergeReason || null,
      })
      return
    }
    if (method === 'DELETE') {
      const r = await deleteLearnedPair(glanceHome(), id, { ctx: state.hostCtx, log })
      if (!r.ok) {
        send(res, 404, { ok: false, rejected: [r.reason || '删除失败'] })
        return
      }
      log(`已删除学会记录 ${id} scheduleDeleted=${r.scheduleDeleted}`)
      send(res, 200, { ok: true, ...r })
      return
    }
    send(res, 405, { ok: false, rejected: ['只支持 GET / PATCH / DELETE'] })
    return
  }

  send(res, 404, { ok: false, rejected: ['没有这条路由'] })
}

function installRoutes(ctx, log, state) {
  if (typeof ctx?.inject !== 'function') {
    log('宿主没有 ctx.inject，跳过 HTTP 接口')
    return
  }
  state.hostCtx = ctx
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () => scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => handle(req, res, readConnection(scoped), log, state),
        }),
        'dsh-pet-enhance: routes',
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
      const disposers = []
      let disposed = false

      scoped.effect(() => () => {
        disposed = true
        state.tools = state.tools.filter((n) => n !== TOOL_NAME && n !== ACT_TOOL_NAME)
        for (const d of disposers.splice(0)) {
          try { d() } catch { /* 已经摘过 */ }
        }
      }, 'dsh-pet-enhance: tools')

      try {
        if (disposed) return
        const petHooks = {
          onLooking: () => state.glance.setPet('looking'),
          onActing: () => state.glance.setPet('acting'),
          onIdle: () => {
            const cur = state.glance.snapshot().pet.state.data
            if (cur === 'looking' || cur === 'acting') state.glance.setPet('idle')
          },
        }
        state.attachments = scoped.attachments
        state.wakeBudget = state.wakeBudget || createWakeBudget()
        state.lastGlanceMap = null
        state.lastInputClick = null
        state.glanceTool = createGlanceTool({
          home: glanceHome(),
          attachments: scoped.attachments,
          log,
          sidecar: state.sidecar,
          onLooking: petHooks.onLooking,
          onIdle: petHooks.onIdle,
          wakeBudget: state.wakeBudget,
          onGlanceMap: (map) => { state.lastGlanceMap = map },
        })
        disposers.push(scoped.tools.register(state.glanceTool))
        state.tools.push(TOOL_NAME)
        log(`工具已注册：${TOOL_NAME}`)

        const actTool = createActTool({
          home: glanceHome(),
          log,
          sidecar: state.sidecar,
          isArmed: () => state.glance.snapshot().guard.armed.data,
          onActing: petHooks.onActing,
          onIdle: petHooks.onIdle,
          budget: state.budget,
          confirmGate: state.confirmGate,
          rememberedConfirms: state.rememberedConfirms,
          turnKey: () => state.lastSessionId || 'default',
          getWindowTitle: () => state.glance.snapshot().side.window.data?.title ?? null,
          getScreen: () => state.sidecar?.getHello?.()?.screen ?? null,
          getLastGlanceMap: () => state.lastGlanceMap,
          getLastInputClick: () => state.lastInputClick,
          onInputClick: (p) => { state.lastInputClick = p },
          onConfirmAsk: async () => {
            // 可见性：confirmGate.onPending → 说话气泡 + 右键「好/不要」；头顶 UI 仍由 overlay / Helper 补丁负责。
          },
          onPolicyDeny: async ({ code, userBubble, reason }) => {
            const text = userBubble
              || (code === 'DENIED_WINDOW'
                ? '这个窗口在黑名单里，我不能点也不能打字。'
                : code === 'BUDGET_EXCEEDED'
                  ? c3BudgetExceededBubble()
                  : (reason || '这个动作被策略拦住了。'))
            await sayConclusionToPet(text, { duration: 12_000 })
          },
        })
        state.runAct = (args) => actTool.execute(args)
        disposers.push(scoped.tools.register(actTool))
        state.tools.push(ACT_TOOL_NAME)
        log(`工具已注册：${ACT_TOOL_NAME}（C2：策略/确认/审计；默认关闭）`)
      } catch (e) {
        writeError(e, 'glance-tools')
        log(`工具没挂上：${e?.message ?? e}`)
      }
    })
  } catch (e) {
    writeError(e, 'glance-tools')
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
    writeHostOrigin(glanceHome(), origin)
    log(`dsh-pet bridge origin=${origin}`)

    // 桌面独立窗：双击开对话 + 头顶确认；chatWithPet / chat-panel 闸门抑制任务抢答。
    try {
      const token = ensureDesktopToken(glanceHome())
      const clickPatched = applyDshPetClickPatches()
      const confirmPatched = applyDshPetConfirmPatches({ token })
      const chatGatePatched = applyDshPetChatGatePatches()
      const chatClientPatched = applyDshPetChatClientPatches()
      const all = [
        ...clickPatched.results,
        ...confirmPatched.results,
        ...chatGatePatched.results,
        ...chatClientPatched.results,
      ]
      const hit = all.filter((r) => r.changed || r.reason === 'already-patched' || r.reason === 'unchanged')
      if (hit.length) {
        log(`dsh-pet 补丁：${hit.map((r) => `${r.reason}`).join(', ')}`)
      }
      if (all.some((r) => r.changed)) {
        callDshPet('/reload', { method: 'POST', timeoutMs: 5_000 })
          .then((r) => {
            if (r.ok) log('已请求重载 dsh-pet 桌面 Helper（确认/对话补丁生效）')
            else log(`重载桌面 Helper 未成功：${r.error || r.status || JSON.stringify(r.data)}`)
          })
          .catch((e) => log(`重载桌面 Helper 异常：${e?.message ?? e}`))
      }
    } catch (e) {
      log(`dsh-pet 补丁失败：${e?.message ?? e}`)
    }

    let stopped = false
    let registered = false
    let liveWatch = false
    let actEnabled = false
    const home = glanceHome()
    const petHooks = {
      onLooking: () => state.glance.setPet('looking'),
      onIdle: () => {
        if (state.glance.snapshot().pet.state.data === 'looking') {
          state.glance.setPet('idle')
        }
      },
    }
    const bridge = createChatBridge({
      home,
      sidecar: () => state.sidecar,
      log,
      pollChat: false,
      greetOnStart: false,
      ...petHooks,
    })
    const agent = createAgentBridge({
      ctx,
      home,
      log,
      pollChat: false,
      getPreferredSessionId: () => state.lastSessionId,
      isAborted: () => state.glance.isPanicking?.() || !state.glance.snapshot().guard.armed.data,
      resetActBudget: () => {
        state.budget?.reset()
        state.rememberedConfirms?.clear()
        state.glance.clearPanicHold?.()
      },
      onSession: (sid) => {
        if (sid) state.lastAgentSessionId = String(sid)
      },
      onActing: () => state.glance.setPet('acting'),
      onIdle: () => {
        if (state.glance.snapshot().pet.state.data === 'acting') {
          state.glance.setPet('idle')
        }
      },
    })
    const live = createLiveWatch({
      home,
      sidecar: () => state.sidecar,
      log,
      ...petHooks,
    })
    // setLiveWatch 在下方定义；教学确保开实时看屏幕时经此回调，保持菜单/live 同步。
    let setLiveWatchRef = async () => {}
    const teach = createTeachBridge({
      ctx,
      home,
      sidecar: () => state.sidecar,
      log,
      pollChat: false,
      confirmGate: state.confirmGate,
      getPreferredSessionId: () => state.lastSessionId,
      ensureLiveWatch: async (on) => { await setLiveWatchRef(on) },
      get attachments() { return state.attachments || null },
      resetActBudget: () => {
        state.budget?.reset()
        state.rememberedConfirms?.clear()
        state.glance.clearPanicHold?.()
      },
      isAborted: () => state.glance.isPanicking?.() || !state.glance.snapshot().guard.armed.data,
      onSession: (sid) => {
        if (sid) state.lastAgentSessionId = String(sid)
      },
      runAct: (args) => {
        if (typeof state.runAct === 'function') return state.runAct(args)
        return Promise.resolve({ text: 'act 未就绪', meta: { ok: false, code: 'ACT_UNREADY' } })
      },
      onTeaching: (on) => {
        state.glance.setPet(on ? 'looking' : 'idle')
        // 对话带教：不再弹出「我教完了」录制条
        state.glance.setTeachEndOffer(false)
      },
    })
    state.teachBridge = teach
    state.chatBridge = bridge
    state.agentBridge = agent
    state.chatGateCtx = ctx
    state.hostCtx = ctx
    state.chatGateReady = true
    const router = createPetRouter({
      ctx,
      home,
      log,
      chatBridge: bridge,
      agentBridge: agent,
      teachBridge: teach,
      getPreferredSessionId: () => state.lastSessionId,
      onSession: (sid) => {
        if (sid) {
          state.lastSessionId = String(sid)
          state.lastAgentSessionId = String(sid)
        }
      },
      openNewSession: () => openOwnerWorkspaceSession(state, log),
      wasHandledByChatGate: (user) => {
        const h = state.chatGateHandled
        if (!h?.content) return false
        if (h.content !== user.content) return false
        return Date.now() - Number(h.at || 0) < 90_000
      },
    })

    const syncLive = () => {
      if (liveWatch) live.start()
      else live.stop()
    }

    let locale = getLocale(home)
    /** 避免反复 register 冲掉未取走的菜单点击（急停点了却像没反应）。 */
    let lastMenuSig = ''

    const menuHit = (ev, key) => menuLabelVariants(key).some((label) => Boolean(ev?.[label]))

    const menuSignature = () => {
      const pending = state.confirmGate?.getPending?.()
        ?? state.glance.snapshot().guard.pendingConfirm.data
      return [
        locale,
        liveWatch ? '1' : '0',
        actEnabled ? '1' : '0',
        pending?.id ? '1' : '0',
      ].join('|')
    }

    const pushMenu = async ({ force = false } = {}) => {
      const sig = menuSignature()
      if (!force && registered && sig === lastMenuSig) return true
      const pending = state.confirmGate?.getPending?.()
        ?? state.glance.snapshot().guard.pendingConfirm.data
      const r = await registerGlanceMenu({
        liveWatch,
        actEnabled,
        pendingConfirm: Boolean(pending?.id),
        locale,
      })
      if (r.ok) {
        registered = true
        lastMenuSig = sig
        return true
      }
      log(`挂菜单失败：${r.error || r.status || JSON.stringify(r.data)}`)
      return false
    }

    const doPanicFromMenu = async (via) => {
      await runUserPanic(state, log, via)
      await pushMenu()
    }

    /** 挂起确认：只刷新右键「好/不要」；头顶按钮由 Helper 确认补丁负责，不另发说话冒泡。 */
    state.onConfirmPending = (pending) => {
      pushMenu().catch(() => {})
      void pending
    }
    state.onLocaleChange = async (nextLocale) => {
      locale = String(nextLocale || locale)
      await pushMenu()
    }

    const ensureMenu = async () => {
      if (stopped) return
      const probed = await probeDshPet({ timeoutMs: 1_200 })
      if (!probed.available) {
        registered = false
        return
      }
      const was = registered
      if (await pushMenu() && !was) {
        log(`已在 dsh-pet「更多」挂上菜单（locale=${locale}）`)
      }
    }

    const setLiveWatch = async (next, { quiet = false } = {}) => {
      liveWatch = Boolean(next)
      await saveSettings(home, { liveWatch }).catch((e) => {
        log(`保存设置失败：${e?.message ?? e}`)
      })
      syncLive()
      await pushMenu()
      if (!quiet) {
        await broadcastToDshPet(
          t(locale, liveWatch ? 'bubble.liveOn' : 'bubble.liveOff'),
          { duration: 10_000 },
        )
      }
      log(`实时看屏幕 → ${liveWatch ? '开' : '关'}`)
    }
    setLiveWatchRef = (on) => setLiveWatch(on, { quiet: true })

    const setActEnabled = async (next) => {
      actEnabled = Boolean(next)
      await saveSettings(home, { actEnabled }).catch((e) => {
        log(`保存设置失败：${e?.message ?? e}`)
      })
      await pushMenu()
      await broadcastToDshPet(
        t(locale, actEnabled ? 'bubble.actOn' : 'bubble.actOff'),
        { duration: 10_000 },
      )
      log(`允许动手 → ${actEnabled ? '开' : '关'}`)
    }

    const pollMenu = async () => {
      if (stopped || !registered) return
      const r = await callDshPet(
        `/menu/events?owner=${encodeURIComponent(MENU_OWNER)}&wait=0`,
        { method: 'GET', timeoutMs: 3_000 },
      )
      if (!r.ok || !r.data?.ok || !r.data.events) return
      const ev = r.data.events
      if (menuHit(ev, 'menu.stop')) {
        await doPanicFromMenu('menu')
      }
      // 点当前文案即翻转；中英文开/关两态都认，避免重注册竞态漏点。
      if (menuHit(ev, 'menu.liveOn') || menuHit(ev, 'menu.liveOff')) {
        await setLiveWatch(!liveWatch)
      }
      if (menuHit(ev, 'menu.actOn') || menuHit(ev, 'menu.actOff')) {
        await setActEnabled(!actEnabled)
      }
      if (menuHit(ev, 'menu.recentChat')) {
        try {
          const opened = await openRecentChat({ home, log })
          if (opened.ok) {
            await broadcastToDshPet(t(locale, 'bubble.recentChatOpened'), { duration: 6_000 })
            log(`已打开最近聊天：${opened.path}（${opened.count} 条）`)
          } else {
            const key = /还没有聊天/.test(opened.error || '')
              ? 'bubble.recentChatEmpty'
              : 'bubble.recentChatFail'
            await broadcastToDshPet(
              t(locale, key, { error: opened.error || '未知错误' }),
              { duration: 8_000 },
            )
            log(`打开最近聊天失败：${opened.error}`)
          }
        } catch (e) {
          await broadcastToDshPet(
            t(locale, 'bubble.recentChatFail', { error: e?.message ?? e }),
            { duration: 8_000 },
          )
        }
      }
      if (menuHit(ev, 'menu.confirmYes') || menuHit(ev, 'menu.confirmNo')) {
        const pending = state.confirmGate?.getPending?.()
        if (pending?.id) {
          const allow = menuHit(ev, 'menu.confirmYes')
          state.confirmGate.resolve(pending.id, allow)
          log(`dsh-pet 菜单确认 allow=${allow} id=${pending.id}`)
          await pushMenu()
          await broadcastToDshPet(
            allow ? '已确认，继续做。' : '已拒绝，不再试。',
            { duration: 6_000 },
          )
        }
      }
    }

    loadSettings(home).then((s) => {
      if (stopped) return
      liveWatch = Boolean(s.liveWatch)
      actEnabled = Boolean(s.actEnabled)
      locale = s.locale || locale
      syncLive()
      pushMenu().catch(() => {})
    }).catch(() => {})

    bridge.start()
    agent.start()
    teach.start()
    router.start()
    ensureMenu().catch(() => {})
    let menuTicks = 0
    const timer = setInterval(() => {
      menuTicks += 1
      // 每秒捞菜单事件：急停/确认不能等；重注册仅在文案变化时（见 pushMenu）
      pollMenu().catch(() => {})
      if (menuTicks % 8 === 0) {
        ensureMenu().catch(() => {})
      }
    }, 1_000)
    return () => {
      stopped = true
      clearInterval(timer)
      router.stop()
      bridge.stop()
      agent.stop()
      teach.stop()
      live.stop()
      if (registered) clearGlanceMenu().catch(() => {})
    }
  }

  // Host 侧必须经 webServer 拿绝对 origin；没有 inject 时（单测）允许空跑。
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        if (typeof scoped?.effect === 'function') {
          scoped.effect(() => run(resolveDshOrigin(scoped.webServer)), 'dsh-pet-enhance: dsh-pet bridge')
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
    ctx.effect(() => run(resolveDshOrigin(ctx.webServer)), 'dsh-pet-enhance: dsh-pet bridge')
    return
  }
  disposers.push(run(resolveDshOrigin(ctx?.webServer)))
}

/**
 * 主人说新开窗：建工作区会话、复制权限、模式默认标准，并切到该会话。
 * @param {object} state
 * @param {(m: string) => void} log
 */
async function openOwnerWorkspaceSession(state, log) {
  const ctx = state.hostCtx || state.chatGateCtx || {}
  const r = await openNewWorkspaceSession(ctx, {
    preferredId: state.lastSessionId,
    log,
  })
  if (!r.ok) {
    await sayConclusionToPet(
      `新开聊天窗失败：${r.reason || '未知'}。也可在 Harness 里点「新建会话」。`,
      { duration: 12_000 },
    )
    return r
  }
  state.lastSessionId = r.sessionId
  state.lastAgentSessionId = r.sessionId
  const perm = r.permissionCopied
    ? `权限 ${r.permission || 'danger-full-access'}`
    : `权限未写上（目标 ${r.permission || 'danger-full-access'}）`
  const effort = r.reasoningEffort
    ? (r.reasoningApplied ? `推理 ${r.reasoningEffort}` : `推理 ${r.reasoningEffort} 未写上`)
    : '推理未指定'
  await sayConclusionToPet(
    `已新开工作区聊天窗（id=${String(r.sessionId).slice(0, 12)}）。`
    + `${perm}；模式 standard；${effort}。之后交办走这个窗。`,
    { duration: 14_000 },
  )
  return r
}

/** 跟踪最近有事件的会话，供 L→Agent 叫醒时使用。 */
function installSessionTracker(ctx, log, state) {
  if (typeof ctx?.on !== 'function') return
  try {
    const off = ctx.on('session/event', (session) => {
      try {
        const id = session?.header?.id ?? session?.id
        if (id) state.lastSessionId = String(id)
      } catch { /* ignore */ }
    })
    if (typeof ctx.effect === 'function' && typeof off === 'function') {
      ctx.effect(() => () => { try { off() } catch { /* ignore */ } }, 'dsh-pet-enhance: session tracker')
    }
  } catch (e) {
    log(`session/event 钩子失败：${e?.message ?? e}`)
  }
}

function installSidecar(ctx, log, state, disposers) {
  const manager = createSidecarManager({ log, home: glanceHome() })
  state.sidecar = manager

  if (process.env.DSH_PET_ENHANCE_NO_SIDECAR === '1' || process.env.DSH_GLANCE_NO_SIDECAR === '1') {
    log('DSH_PET_ENHANCE_NO_SIDECAR=1，跳过 sidecar')
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
    }, 'dsh-pet-enhance: sidecar')
    return
  }

  startSafe()
  disposers.push(() => { void manager.stop() })
}

export async function apply(ctx) {
  const log = (m) => { try { ctx?.logger?.info?.(`[dsh-pet-enhance] ${m}`) } catch { /* 日志不该影响加载 */ } }
  const disposers = []
  const state = {
    tools: [],
    sidecar: null,
    glance: createGlanceState(),
    glanceTool: null,
    wakeBudget: createWakeBudget(),
    lastSessionId: null,
    budget: createActionBudget(),
    rememberedConfirms: new Set(),
    confirmGate: null,
    onConfirmPending: null,
    chatGateReady: false,
    chatGateHandled: null,
    chatGateCtx: null,
    hostCtx: null,
    lastAgentSessionId: null,
    chatBridge: null,
    agentBridge: null,
    teachBridge: null,
    _windowAt: 0,
    _dshPetAt: 0,
    _dshPet: { available: false, pets: [] },
  }
  state.confirmGate = createConfirmGate({
    log,
    onPending: (pending) => {
      state.glance.setPendingConfirm(pending)
      try { state.onConfirmPending?.(pending) } catch { /* ignore */ }
    },
  })

  try {
    const home = glanceHome()
    mkdirSync(join(home, 'episodes'), { recursive: true })
    mkdirSync(join(home, 'teach'), { recursive: true })
    mkdirSync(join(home, 'learned'), { recursive: true })
    mkdirSync(join(home, 'automations'), { recursive: true })
    ensureDesktopToken(home)
    log(`home: ${home}`)
    installSidecar(ctx, log, state, disposers)
    installSessionTracker(ctx, log, state)
    installDshPetBridge(ctx, log, state, disposers)
    installRoutes(ctx, log, state)
    installTools(ctx, log, state)
  } catch (e) {
    writeError(e)
    log(`加载失败：${e?.message ?? e}`)
    for (const d of disposers.reverse()) { try { d() } catch { /* 收拾不干净也不能再抛 */ } }
    if (process.env.DSH_PET_ENHANCE_DEBUG || process.env.DSH_GLANCE_DEBUG) throw e
    return () => {}
  }

  return () => {
    for (const d of disposers.reverse()) { try { d() } catch { /* 同上 */ } }
  }
}
