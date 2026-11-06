/**
 * 叫醒 DSH 会话里的 Agent（模型可调 glance / act）。
 * 写法对齐 see-now：resolveAgent → followup → sessions.flush。
 *
 * @module src/wake-session.js
 */

import { randomUUID } from 'node:crypto'
import { serviceOf } from './host-ctx.js'

/**
 * @param {string} text
 * @param {string | { sourceKind?: string, contentExtra?: object[] }} [opts]
 */
export function followupMessage(text, opts = 'dsh-glance') {
  const sourceKind = typeof opts === 'string' ? opts : (opts.sourceKind || 'dsh-glance')
  const contentExtra = typeof opts === 'object' && Array.isArray(opts.contentExtra)
    ? opts.contentExtra
    : []
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }, ...contentExtra],
    source: { kind: sourceKind },
  }
}

/** 从已加载会话里挑一个目标：优先最近活跃，其次列表第一个。 */
export function pickSessionId(ctx, preferredId = null) {
  const want = preferredId != null ? String(preferredId) : ''
  if (want) return want

  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions) return null

  try {
    if (typeof sessions.list === 'function') {
      const list = sessions.list() || []
      for (const s of list) {
        if (s?.focused || s?.active || s?.selected) return String(s.id)
      }
      if (list.length) return String(list[0].id)
    }
  } catch { /* ignore */ }

  return null
}

/**
 * @param {object} ctx
 * @param {{
 *   sessionId?: string,
 *   text?: string,
 *   preferredId?: string | null,
 *   images?: { png?: Buffer, data?: Buffer, name?: string }[],
 *   attachments?: { saveImage?: Function },
 * }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string, via?: string, flushed?: unknown, sessionId?: string }>}
 */
export async function wakeSession(ctx, {
  sessionId,
  text,
  preferredId = null,
  images = null,
  attachments = null,
} = {}) {
  const sc = serviceOf(ctx, 'sessionController')
  if (!sc?.resolveAgent) return { ok: false, reason: 'no-session-controller' }

  const sid = sessionId || pickSessionId(ctx, preferredId)
  if (!sid) return { ok: false, reason: 'no-session-id' }

  try {
    const resolved = await sc.resolveAgent(sid)
    if (!resolved || resolved.error || !resolved.agent) {
      const reason = resolved?.error?.message ?? resolved?.error ?? 'resolve-failed'
      return { ok: false, reason: String(reason).slice(0, 160), sessionId: sid }
    }

    const contentExtra = []
    const saveImage = attachments?.saveImage
    if (typeof saveImage === 'function' && Array.isArray(images) && images.length) {
      for (const img of images.slice(0, 7)) {
        const data = img.png || img.data
        if (!data) continue
        try {
          const ref = await saveImage.call(attachments, {
            data,
            mediaType: 'image/png',
            name: img.name || 'teach-frame.png',
          })
          if (ref) contentExtra.push({ type: 'image', attachment: ref })
        } catch { /* 单张失败不挡文字 */ }
      }
    }

    resolved.agent.followup(followupMessage(text, { contentExtra }))
    let flushed = null
    try {
      const sessions = serviceOf(ctx, 'sessions')
      if (sessions?.flush) flushed = await sessions.flush(resolved.agent.session)
    } catch {
      flushed = false
    }
    return { ok: true, via: 'followup', flushed, sessionId: sid, imageCount: contentExtra.length }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160), sessionId: sid }
  }
}

/**
 * 等本轮 turn 结束后取出助手文本（给桌宠冒泡）。
 * @returns {Promise<{ ok: boolean, text?: string, reason?: string }>}
 */
export async function waitAssistantReply(ctx, sessionId, {
  baselineSeq = null,
  timeoutMs = 120_000,
  pollMs = 800,
  isAborted = () => false,
} = {}) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions?.get) return { ok: false, reason: 'no-sessions' }
  const sid = String(sessionId || '')
  if (!sid) return { ok: false, reason: 'no-session-id' }

  const started = Date.now()
  let seq = baselineSeq
  const turns = new Map()

  while (Date.now() - started < timeoutMs) {
    if (isAborted()) return { ok: false, reason: 'aborted' }
    let session
    try {
      session = sessions.get(sid)
    } catch {
      session = null
    }
    if (!session) {
      await sleep(pollMs)
      continue
    }

    if (seq == null) {
      seq = Number(session.seq) || 0
      await sleep(pollMs)
      continue
    }

    const cur = Number(session.seq) || 0
    if (cur > seq) {
      let events = []
      try {
        events = session.snapshotEvents(seq) || []
      } catch {
        events = []
      }
      seq = cur
      for (const event of events) {
        if (!event) continue
        const data = event.data || {}
        if (data.turn === undefined || data.turn === null) continue
        if (event.type === 'assistant/message') {
          const parts = turns.get(data.turn) || []
          const blocks = data.message?.content
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                parts.push(b.text.trim())
              }
            }
          }
          turns.set(data.turn, parts)
        } else if (event.type === 'turn/end') {
          const parts = turns.get(data.turn) || []
          turns.delete(data.turn)
          if (data.reason?.kind === 'completed' && parts.length) {
            return { ok: true, text: parts.join('\n\n') }
          }
        }
      }
    }
    await sleep(pollMs)
  }
  return { ok: false, reason: 'timeout' }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
