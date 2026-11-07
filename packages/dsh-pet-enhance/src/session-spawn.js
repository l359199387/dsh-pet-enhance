/**
 * 主人说「新开窗口聊天」或交办/执行时：新建工作区会话。
 * 默认：完全权限 + 标准模式 + 推理 low（干净会话，避免吃肥历史）。
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
/** 默认推理档：省钱；复杂任务可再升。 */
export const DEFAULT_REASONING_EFFORT = 'low'

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
 * 找上一会话所在的 workspace（同工作区新开窗）。
 * @param {object} ctx
 * @param {string | null} sessionId
 * @returns {{ id: string, path?: string } | null}
 */
export function findWorkspaceForSession(ctx, sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return null
  try {
    const list = registry.list() || []
    for (const ws of list) {
      const ids = ws?.sessionIds
      if (Array.isArray(ids) && ids.map(String).includes(sid)) {
        return { id: String(ws.id), path: ws.path ? String(ws.path) : undefined }
      }
    }
  } catch { /* ignore */ }
  return null
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
 * 把会话推理档设为 low（或指定档）。优先 sessionController.selectModel，其次 agent.model.select。
 * @returns {Promise<boolean>}
 */
export async function applySessionReasoningEffort(ctx, sessionId, effort = DEFAULT_REASONING_EFFORT) {
  const want = String(effort || '').trim()
  const sid = String(sessionId || '').trim()
  if (!want || !sid) return false

  const sc = serviceOf(ctx, 'sessionController')
  if (!sc || typeof sc.resolveAgent !== 'function') return false

  let resolved
  try {
    resolved = await sc.resolveAgent(sid)
  } catch {
    return false
  }
  const agent = resolved?.agent
  const cur = agent?.model?.current?.()
  if (!cur?.provider || !cur?.model) return false

  const selection = {
    provider: String(cur.provider),
    model: String(cur.model),
    reasoningEffort: want,
  }

  if (typeof sc.selectModel === 'function') {
    try {
      await sc.selectModel({ sessionId: sid, ...selection })
      return true
    } catch { /* fall through */ }
  }

  try {
    if (typeof agent.model?.select === 'function') {
      agent.model.select(selection)
      return true
    }
  } catch { /* ignore */ }
  return false
}

/**
 * 新开工作区聊天窗口：同 workspace、完全权限、标准模式、推理 low。
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
  const workspace = findWorkspaceForSession(ctx, fromSessionId)
  const agentPreset = String(opts.agentPreset || STANDARD_AGENT_PRESET).trim() || STANDARD_AGENT_PRESET
  const reasoningEffort = opts.reasoningEffort === null
    ? null
    : String(opts.reasoningEffort || DEFAULT_REASONING_EFFORT).trim() || DEFAULT_REASONING_EFFORT

  let permission = String(opts.permissionPreset || '').trim() || null
  if (!permission && opts.copyPermissionFromPrevious) {
    permission = readSessionPermissionPreset(ctx, fromSessionId)
  }
  if (!permission) permission = FULL_ACCESS_PERMISSION

  /** @type {Record<string, unknown>} */
  const request = { agentPreset }
  if (workspace?.id) request.workspaceId = workspace.id
  else if (workspace?.path) request.cwd = workspace.path

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
  if (reasoningEffort) {
    reasoningApplied = await applySessionReasoningEffort(ctx, sessionId, reasoningEffort)
    if (!reasoningApplied) log(`session-spawn：推理 ${reasoningEffort} 未能写到新会话 ${sessionId}`)
  }

  const revealed = revealWorkspaceSession(ctx, sessionId)
  log(
    `session-spawn：新会话 ${sessionId}`
    + (workspace?.id ? ` ws=${workspace.id}` : '')
    + ` preset=${agentPreset}`
    + (permission ? ` perm=${permission}${permissionCopied ? '✓' : '✗'}` : '')
    + (modeStandard ? ' mode=standard' : '')
    + (reasoningEffort ? ` effort=${reasoningEffort}${reasoningApplied ? '✓' : '✗'}` : '')
    + (revealed ? ' revealed' : ' reveal-skip'),
  )

  return {
    ok: true,
    sessionId,
    fromSessionId,
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
 * 交办/执行专用：始终新开干净会话（完全权限 + standard + low）。
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
