/**
 * 主人说「新开窗口聊天」或交办/执行时：新建工作区会话。
 * 默认：完全权限 + 标准模式；推理档按模型能力决定——无档不加，有档优先沿用上次，否则 low。
 *
 * @module src/session-spawn.js
 */

import { serviceOf } from './host-ctx.js'
import { pickSessionId } from './wake-session.js'

export const DEFAULT_TRANSCRIPT_MODE = 'standard'
/** 标准工作模式（工具集），与权限预设无关。 */
export const STANDARD_AGENT_PRESET = 'standard'
/** 完全权限：沙箱放行 + 审批 never。 */
export const FULL_ACCESS_PERMISSION = 'danger-full-access'
/** 有思考档位时的默认档：省钱；若用户上次用过其它档则优先沿用。 */
export const DEFAULT_REASONING_EFFORT = 'low'

/** 侧栏工作区统一显示名。 */
export const PET_WORKSPACE_NAME = '小蓝鲸工作区'

/**
 * 侧栏标题：尽量短、带小蓝鲸前缀。
 * @param {string} [hint]
 * @param {string} [fallback]
 */
export function clipSessionTitle(hint, fallback = '交办') {
  const raw = String(hint || '').replace(/\s+/g, ' ').trim()
  const body = (raw || fallback).replace(/^小蓝鲸[｜|·\s]*/u, '')
  const titled = `小蓝鲸｜${body}`
  return titled.slice(0, 40)
}

/**
 * 给会话写标题。宿主 create 不吃 title——必须事后 rename。
 * 权威路径：sessionController.rename({ sessionId, title })
 * 或 sessionTitle.rename(session, title)。
 * @returns {Promise<boolean>}
 */
export async function applySessionTitle(ctx, sessionId, title) {
  const sid = String(sessionId || '').trim()
  const name = String(title || '').trim().slice(0, 80)
  if (!sid || !name) return false

  const sc = serviceOf(ctx, 'sessionController')
  try {
    if (typeof sc?.rename === 'function') {
      await sc.rename({ sessionId: sid, title: name })
      return true
    }
  } catch { /* try next */ }

  const sessions = serviceOf(ctx, 'sessions')
  const sessionTitle = serviceOf(ctx, 'sessionTitle')
  try {
    const session = sessions?.get?.(sid)
    if (session && typeof sessionTitle?.rename === 'function') {
      // 宿主形状是 rename(session, title)，不是 rename(sessionId, title)
      sessionTitle.rename(session, name)
      return true
    }
  } catch { /* try next */ }

  try {
    const session = sessions?.get?.(sid)
    if (session && typeof session.rename === 'function') {
      const out = session.rename(name)
      if (out && typeof out.then === 'function') await out
      return true
    }
  } catch { /* ignore */ }

  return false
}

/**
 * 从 create 返回值里抠 session id。
 * @param {unknown} created
 * @returns {string | null}
 */
export function extractCreatedSessionId(created) {
  if (!created || typeof created !== 'object') return null
  const c = /** @type {Record<string, any>} */ (created)
  const candidates = [
    c.sessionId,
    c.id,
    c.agent?.id,
    c.agent?.sessionId,
    c.session?.id,
    c.header?.id,
  ]
  for (const v of candidates) {
    if (v != null && String(v).trim()) return String(v)
  }
  return null
}

/**
 * @param {object} ctx
 * @returns {object[]}
 */
export function listWorkspaces(ctx) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return []
  try {
    const list = registry.list() || []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * @param {object | null | undefined} ws
 */
export function workspaceDisplayName(ws) {
  // 宿主持久字段是 title（workspace.setTitle）；name 多为路径派生
  return String(ws?.title || ws?.name || ws?.label || ws?.displayName || '').trim()
}

/**
 * 找上一会话所在的 workspace（同工作区新开窗）。
 * @param {object} ctx
 * @param {string | null} sessionId
 * @returns {{ id: string, path?: string, name?: string | null } | null}
 */
export function findWorkspaceForSession(ctx, sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  try {
    for (const ws of listWorkspaces(ctx)) {
      const ids = ws?.sessionIds
      if (Array.isArray(ids) && ids.map(String).includes(sid)) {
        return {
          id: String(ws.id),
          path: ws.path ? String(ws.path) : undefined,
          name: workspaceDisplayName(ws) || null,
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 给工作区改显示名。权威：workspaceController.rename / workspace.setTitle。
 * 侧栏「未分组」= 会话没挂 workspaceId；分组标题读的是 workspace.title。
 * @returns {Promise<boolean>}
 */
export async function applyWorkspaceName(ctx, workspaceOrId, name) {
  const want = String(name || '').trim()
  if (!want) return false
  const id = typeof workspaceOrId === 'string'
    ? String(workspaceOrId).trim()
    : String(workspaceOrId?.id || '').trim()
  if (!id) return false

  const wc = serviceOf(ctx, 'workspaceController')
  try {
    if (typeof wc?.rename === 'function') {
      await wc.rename({ workspaceId: id, title: want })
      return true
    }
  } catch { /* try next */ }

  const registry = serviceOf(ctx, 'workspaceRegistry')
  let live = null
  try {
    live = typeof registry?.get === 'function'
      ? registry.get(id)
      : null
  } catch { /* ignore */ }
  if (!live) {
    try {
      live = listWorkspaces(ctx).find((w) => String(w?.id) === id) || null
    } catch { /* ignore */ }
  }
  if (!live && workspaceOrId && typeof workspaceOrId === 'object') live = workspaceOrId

  try {
    if (live && typeof live.setTitle === 'function') {
      await live.setTitle(want)
      return true
    }
  } catch { /* try next */ }

  try {
    if (typeof registry?.rename === 'function') {
      await registry.rename(id, want)
      return true
    }
  } catch { /* ignore */ }

  return false
}

/**
 * 把当前/默认工作区统一命名为「小蓝鲸工作区」，并返回应用对象。
 * @param {object} ctx
 * @param {{ preferredId?: string | null, log?: (m: string) => void }} [opts]
 */
export async function ensurePetWorkspace(ctx, opts = {}) {
  const log = opts.log ?? (() => {})
  const preferredId = opts.preferredId ?? null

  let all = listWorkspaces(ctx)
  if (!all.length) {
    const wc = serviceOf(ctx, 'workspaceController')
    if (typeof wc?.initializeDefault === 'function') {
      try {
        await wc.initializeDefault()
        all = listWorkspaces(ctx)
        log('workspace：已 initializeDefault')
      } catch (e) {
        log(`workspace：initializeDefault 失败：${e?.message ?? e}`)
      }
    }
  }

  const named = all.find((w) => workspaceDisplayName(w) === PET_WORKSPACE_NAME)
  const fromSession = findWorkspaceForSession(ctx, preferredId)
  const byPath = all.find((w) => /default-workspace/i.test(String(w?.path || '')))
  const pick = named || fromSession || byPath || (all[0]
    ? {
      id: String(all[0].id),
      path: all[0].path ? String(all[0].path) : undefined,
      name: workspaceDisplayName(all[0]) || null,
      title: all[0].title,
    }
    : null)

  if (!pick?.id) {
    log('workspace：没有可用工作区可改名')
    return { ok: false, reason: 'no-workspace' }
  }

  if (workspaceDisplayName(pick) === PET_WORKSPACE_NAME) {
    return {
      ok: true,
      renamed: false,
      workspace: { id: pick.id, path: pick.path, name: PET_WORKSPACE_NAME },
    }
  }

  const renamed = await applyWorkspaceName(ctx, pick.id, PET_WORKSPACE_NAME)
  log(
    renamed
      ? `workspace：已命名「${PET_WORKSPACE_NAME}」id=${pick.id}`
      : `workspace：改名未确认（仍用 id=${pick.id}）`,
  )
  return {
    ok: true,
    renamed,
    workspace: { id: pick.id, path: pick.path, name: PET_WORKSPACE_NAME },
  }
}

/**
 * 读上一会话权限 preset（如 danger-full-access）。
 * @param {object} ctx
 * @param {object | string | null} sessionOrId
 * @returns {string | null}
 */
export function readSessionPermissionPreset(ctx, sessionOrId) {
  const presets = serviceOf(ctx, 'permissionPresets')
  if (!presets || typeof presets.current !== 'function') return null
  try {
    let session = sessionOrId
    if (typeof sessionOrId === 'string') {
      const sessions = serviceOf(ctx, 'sessions')
      session = sessions?.get?.(sessionOrId) ?? null
    }
    if (!session) return null
    const cur = presets.current(session)
    if (cur == null) return null
    const s = String(cur).trim()
    return s || null
  } catch {
    return null
  }
}

/**
 * 把权限写到新会话。
 * @returns {boolean}
 */
export function applySessionPermissionPreset(ctx, sessionOrId, preset) {
  const name = String(preset || '').trim()
  if (!name) return false
  const presets = serviceOf(ctx, 'permissionPresets')
  if (!presets || typeof presets.set !== 'function') return false
  try {
    let session = sessionOrId
    if (typeof sessionOrId === 'string') {
      const sessions = serviceOf(ctx, 'sessions')
      session = sessions?.get?.(sessionOrId) ?? null
    }
    if (!session) return false
    presets.set(session, name)
    return true
  } catch {
    return false
  }
}

/**
 * 尽量把工作详情模式设为标准（standard）。宿主无此服务时静默跳过。
 * @returns {boolean}
 */
export function applyStandardTranscriptMode(ctx) {
  const candidates = [
    serviceOf(ctx, 'presentationPolicy'),
    serviceOf(ctx, 'transcriptView'),
    serviceOf(ctx, 'chatPresentation'),
    serviceOf(ctx, 'uiChatPresentation'),
  ].filter(Boolean)
  for (const svc of candidates) {
    try {
      if (typeof svc.setMode === 'function') {
        svc.setMode(DEFAULT_TRANSCRIPT_MODE)
        return true
      }
      if (typeof svc.set === 'function') {
        svc.set(DEFAULT_TRANSCRIPT_MODE)
        return true
      }
    } catch { /* try next */ }
  }
  return false
}

/**
 * 查模型是否声明思考档位菜单，以及支持哪些档。
 * 走宿主 `llm` 服务的 resolveModelInfo(provider, model)：它按 adapter 解析并校验，
 * 返回带 `reasoning.efforts` / `reasoning.defaultEffort` 的能力；取不到服务或模型时
 * 一律当「不支持档位」处理——宁可少写，也不能写错把运行时炸挂
 *（trae/DeepSeek-V4-Flash 一类无 thinkingConfig 的模型就是这样炸的）。
 * @returns {Promise<{ efforts: string[], defaultEffort: string | null } | null>}
 */
export async function modelReasoningMenu(ctx, provider, model) {
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') return null
  let info
  try {
    info = await llm.resolveModelInfo(String(provider), String(model))
  } catch {
    return null
  }
  const reasoning = info?.reasoning
  if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return null
  return {
    efforts: reasoning.efforts
      .map((e) => String(typeof e === 'string' ? e : (e?.id || '')).trim())
      .filter(Boolean),
    defaultEffort: reasoning.defaultEffort ? String(reasoning.defaultEffort) : null,
  }
}

/**
 * 决定会话推理档。三条规则（都通过宿主能力判断，避免 UNSUPPORTED_REASONING_EFFORT）：
 * 1. 模型没有思考档位菜单 → 不给它写档位（返回 null，跳过）。
 * 2. 用户上次用过的档位在支持列表里 → 沿用。
 * 3. 否则回落默认档（low）；默认档不在列表里 → 用模型自带的 defaultEffort；再没有就不写。
 * @param {string} defaultEffort 我们想要的默认档（通常 low）
 * @param {string | null | undefined} previous 用户上次用的档
 * @param {{ efforts: string[], defaultEffort: string | null } | null} menu 模型能力
 * @returns {string | null} 真正要写的档位；null 表示不写
 */
export function pickReasoningEffort(defaultEffort, previous, menu) {
  if (!menu) return null
  const { efforts } = menu
  if (!efforts.length) return null
  const prev = String(previous || '').trim()
  if (prev && efforts.includes(prev)) return prev
  const want = String(defaultEffort || '').trim()
  if (want && efforts.includes(want)) return want
  if (menu.defaultEffort && efforts.includes(menu.defaultEffort)) return menu.defaultEffort
  return null
}

/**
 * 读会话当前选中的推理档（宿主 model/selection 投影）。
 * @returns {Promise<string | null>}
 */
export async function readSessionReasoningEffort(ctx, sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  const sc = serviceOf(ctx, 'sessionController')
  if (!sc || typeof sc.resolveAgent !== 'function') return null
  try {
    const resolved = await sc.resolveAgent(sid)
    const cur = resolved?.agent?.model?.current?.()
    const effort = cur?.reasoningEffort
    return effort ? String(effort).trim() || null : null
  } catch {
    return null
  }
}

/**
 * 把会话推理档设好，但只在模型确实支持思考档位时才写。
 * 优先沿用 previousEffort（上一会话用户档），其次目标会话自己的 current，
 * 再回落 preferredEffort（默认 low）。
 * 优先 sessionController.selectModel，其次 agent.model.select。
 * @returns {Promise<{ applied: boolean, effort: string | null }>}
 */
export async function applySessionReasoningEffort(ctx, sessionId, effort = DEFAULT_REASONING_EFFORT, opts = {}) {
  const want = effort === null
    ? null
    : String(effort || DEFAULT_REASONING_EFFORT).trim() || DEFAULT_REASONING_EFFORT
  const sid = String(sessionId || '').trim()
  if (!sid) return { applied: false, effort: null }

  const sc = serviceOf(ctx, 'sessionController')
  if (!sc || typeof sc.resolveAgent !== 'function') return { applied: false, effort: null }

  let resolved
  try {
    resolved = await sc.resolveAgent(sid)
  } catch {
    return { applied: false, effort: null }
  }
  const agent = resolved?.agent
  const cur = agent?.model?.current?.()
  if (!cur?.provider || !cur?.model) return { applied: false, effort: null }

  const provider = String(cur.provider)
  const model = String(cur.model)
  const previous = opts.previousEffort != null
    ? String(opts.previousEffort).trim() || null
    : (cur?.reasoningEffort ? String(cur.reasoningEffort).trim() || null : null)
  const menu = await modelReasoningMenu(ctx, provider, model)
  const picked = pickReasoningEffort(want || DEFAULT_REASONING_EFFORT, previous, menu)
  if (!picked) return { applied: false, effort: null }

  // 已是目标档就别再 append model/selection，避免空写。
  if (cur.reasoningEffort && String(cur.reasoningEffort) === picked) {
    return { applied: true, effort: picked }
  }

  const selection = {
    provider,
    model,
    reasoningEffort: picked,
  }

  if (typeof sc.selectModel === 'function') {
    try {
      await sc.selectModel({ sessionId: sid, ...selection })
      return { applied: true, effort: picked }
    } catch { /* fall through */ }
  }

  try {
    if (typeof agent.model?.select === 'function') {
      agent.model.select(selection)
      return { applied: true, effort: picked }
    }
  } catch { /* ignore */ }
  return { applied: false, effort: null }
}

/**
 * 新开工作区聊天窗口：同 workspace、完全权限、标准模式；
 * 推理档按模型能力写入（无档跳过；有档优先沿用上一会话用户档，否则 low）。
 *
 * @param {object} ctx
 * @param {{
 *   preferredId?: string | null,
 *   titleHint?: string,
 *   permissionPreset?: string | null,
 *   copyPermissionFromPrevious?: boolean,
 *   agentPreset?: string,
 *   reasoningEffort?: string | null,
 *   log?: (m: string) => void,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   sessionId?: string,
 *   fromSessionId?: string | null,
 *   permission?: string | null,
 *   permissionCopied?: boolean,
 *   modeStandard?: boolean,
 *   agentPreset?: string,
 *   reasoningEffort?: string | null,
 *   reasoningApplied?: boolean,
 *   revealed?: boolean,
 *   workspaceId?: string | null,
 * }>}
 */
export async function openNewWorkspaceSession(ctx, opts = {}) {
  const log = opts.log ?? (() => {})
  const sc = serviceOf(ctx, 'sessionController')
  if (!sc || typeof sc.create !== 'function') {
    return { ok: false, reason: 'no-session-controller-create' }
  }

  const fromSessionId = pickSessionId(ctx, opts.preferredId ?? null)
  const ensured = await ensurePetWorkspace(ctx, { preferredId: fromSessionId, log })
  const workspace = ensured.workspace || findWorkspaceForSession(ctx, fromSessionId)
  const agentPreset = String(opts.agentPreset || STANDARD_AGENT_PRESET).trim() || STANDARD_AGENT_PRESET
  // null = 显式不碰推理档；否则 preferred 默认 low，真正写入值由模型菜单 + 上次档位决定
  const preferredEffort = opts.reasoningEffort === null
    ? null
    : String(opts.reasoningEffort || DEFAULT_REASONING_EFFORT).trim() || DEFAULT_REASONING_EFFORT

  let permission = String(opts.permissionPreset || '').trim() || null
  if (!permission && opts.copyPermissionFromPrevious) {
    permission = readSessionPermissionPreset(ctx, fromSessionId)
  }
  if (!permission) permission = FULL_ACCESS_PERMISSION

  const title = clipSessionTitle(opts.titleHint, '交办')

  // 宿主：create 只认 workspaceId 或 cwd（不能同时）；只有 workspaceId 才会 attachSession。
  // 只传 cwd → 侧栏仍显示「未分组」。title 字段会被忽略，须事后 rename。
  /** @type {Record<string, unknown>} */
  const request = { agentPreset }
  if (workspace?.id) {
    request.workspaceId = workspace.id
  } else if (workspace?.path) {
    request.cwd = workspace.path
    log('session-spawn：无 workspaceId，仅 cwd——侧栏可能仍显示未分组')
  }

  let created
  try {
    created = await sc.create(request)
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 160)
    log(`session-spawn create 失败：${msg}`)
    return {
      ok: false,
      reason: msg,
      fromSessionId,
      permission,
      agentPreset,
      workspaceId: workspace?.id || null,
    }
  }

  const sessionId = extractCreatedSessionId(created)
  if (!sessionId) {
    return {
      ok: false,
      reason: 'create-no-session-id',
      fromSessionId,
      permission,
      agentPreset,
      workspaceId: workspace?.id || null,
    }
  }

  // 等会话进 registry 再写权限
  let permissionCopied = false
  for (let i = 0; i < 8; i += 1) {
    permissionCopied = applySessionPermissionPreset(ctx, sessionId, permission)
    if (permissionCopied) break
    await new Promise((r) => setTimeout(r, 40))
  }
  if (!permissionCopied) log(`session-spawn：权限 ${permission} 未能写到新会话 ${sessionId}`)

  const modeStandard = applyStandardTranscriptMode(ctx)
  let reasoningApplied = false
  /** @type {string | null} */
  let reasoningEffort = null
  if (preferredEffort !== null) {
    // 新会话自己还没有用户选择；沿用上一会话（fromSessionId）的档位
    const previousEffort = await readSessionReasoningEffort(ctx, fromSessionId)
    const applied = await applySessionReasoningEffort(ctx, sessionId, preferredEffort, {
      previousEffort,
    })
    reasoningApplied = applied.applied
    reasoningEffort = applied.effort
    if (!reasoningApplied) {
      log(
        previousEffort
          ? `session-spawn：模型无可用推理档（想要 ${preferredEffort}，上次 ${previousEffort}），跳过`
          : `session-spawn：模型无可用推理档（想要 ${preferredEffort}），跳过`,
      )
    }
  }

  let titled = await applySessionTitle(ctx, sessionId, title)
  if (!titled) {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
      titled = await applySessionTitle(ctx, sessionId, title)
      if (titled) break
    }
  }
  if (!titled) log(`session-spawn：标题未能写入 ${sessionId} ← ${title}`)

  const revealed = revealWorkspaceSession(ctx, sessionId)
  log(
    `session-spawn：新会话 ${sessionId}`
    + (workspace?.id ? ` ws=${workspace.id}` : '')
    + ` title=${title}${titled ? '✓' : '✗'}`
    + ` preset=${agentPreset}`
    + (permission ? ` perm=${permission}${permissionCopied ? '✓' : '✗'}` : '')
    + (modeStandard ? ' mode=standard' : '')
    + (reasoningEffort
      ? ` effort=${reasoningEffort}${reasoningApplied ? '✓' : '✗'}`
      : ' effort=skip')
    + (revealed ? ' revealed' : ' reveal-skip'),
  )

  return {
    ok: true,
    sessionId,
    fromSessionId,
    title,
    titled,
    permission,
    permissionCopied,
    modeStandard,
    agentPreset,
    reasoningEffort,
    reasoningApplied,
    revealed,
    workspaceId: workspace?.id || null,
  }
}

/**
 * 交办/执行专用：始终新开干净会话（完全权限 + standard；推理档按模型能力）。
 * create 失败时回落上一会话 id（仍可叫醒，只是吃旧历史）。
 *
 * @param {object} ctx
 * @param {{
 *   preferredId?: string | null,
 *   onSession?: (sessionId: string) => void,
 *   log?: (m: string) => void,
 * }} [opts]
 * @returns {Promise<{ sessionId: string | null, fresh: boolean, spawn?: object }>}
 */
export async function prepareFreshRunSession(ctx, opts = {}) {
  const log = opts.log ?? (() => {})
  const preferredId = opts.preferredId ?? null
  const spawn = await openNewWorkspaceSession(ctx, {
    preferredId,
    titleHint: opts.titleHint,
    permissionPreset: FULL_ACCESS_PERMISSION,
    agentPreset: STANDARD_AGENT_PRESET,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    log,
  })
  if (spawn.ok && spawn.sessionId) {
    try { opts.onSession?.(spawn.sessionId) } catch { /* ignore */ }
    return { sessionId: spawn.sessionId, fresh: true, spawn }
  }
  const fallback = pickSessionId(ctx, preferredId)
  if (fallback) {
    log(`session-spawn：新开失败（${spawn.reason || 'unknown'}），回落旧会话 ${fallback}`)
    return { sessionId: fallback, fresh: false, spawn }
  }
  return { sessionId: null, fresh: false, spawn }
}

/**
 * 把新会话亮到前台（否则 create 了用户也看不见）。
 * @returns {boolean}
 */
export function revealWorkspaceSession(ctx, sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return false
  const ui = serviceOf(ctx, 'uiWorkspace')
  if (!ui) return false
  try {
    if (typeof ui.openSession === 'function') {
      ui.openSession(sid)
      return true
    }
  } catch { /* ignore */ }
  return false
}
