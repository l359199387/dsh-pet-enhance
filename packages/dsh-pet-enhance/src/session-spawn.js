/**
 * 主人说「新开窗口聊天」时：新建工作区会话，复制上一窗权限，模式默认标准。
 *
 * @module src/session-spawn.js
 */

import { serviceOf } from './host-ctx.js'
import { pickSessionId } from './wake-session.js'

export const DEFAULT_TRANSCRIPT_MODE = 'standard'

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
 * 新开工作区聊天窗口：同 workspace、复制权限、模式默认标准。
 *
 * @param {object} ctx
 * @param {{
 *   preferredId?: string | null,
 *   titleHint?: string,
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
  const permission = readSessionPermissionPreset(ctx, fromSessionId)

  /** @type {Record<string, unknown>} */
  const request = {}
  if (workspace?.id) request.workspaceId = workspace.id
  else if (workspace?.path) request.cwd = workspace.path

  let created
  try {
    created = await sc.create(request)
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 160)
    log(`session-spawn create 失败：${msg}`)
    return { ok: false, reason: msg, fromSessionId, permission, workspaceId: workspace?.id || null }
  }

  const sessionId = extractCreatedSessionId(created)
  if (!sessionId) {
    return {
      ok: false,
      reason: 'create-no-session-id',
      fromSessionId,
      permission,
      workspaceId: workspace?.id || null,
    }
  }

  // 等会话进 registry 再写权限
  let permissionCopied = false
  if (permission) {
    for (let i = 0; i < 8; i += 1) {
      permissionCopied = applySessionPermissionPreset(ctx, sessionId, permission)
      if (permissionCopied) break
      await new Promise((r) => setTimeout(r, 40))
    }
    if (!permissionCopied) log(`session-spawn：权限 ${permission} 未能写到新会话 ${sessionId}`)
  }

  const modeStandard = applyStandardTranscriptMode(ctx)
  log(
    `session-spawn：新会话 ${sessionId}`
    + (workspace?.id ? ` ws=${workspace.id}` : '')
    + (permission ? ` perm=${permission}${permissionCopied ? '✓' : '✗'}` : '')
    + (modeStandard ? ' mode=standard' : ''),
  )

  return {
    ok: true,
    sessionId,
    fromSessionId,
    permission,
    permissionCopied,
    modeStandard,
    workspaceId: workspace?.id || null,
  }
}
