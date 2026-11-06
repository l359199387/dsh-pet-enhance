/**
 * 叫醒 DSH 会话里的 Agent（模型可调 glance / act）。
 * 写法对齐 see-now：resolveAgent → followup → sessions.flush。
 *
 * @module src/wake-session.js
 */

import { randomUUID } from 'node:crypto'
import { serviceOf } from './host-ctx.js'

export function followupMessage(text, sourceKind = 'dsh-glance') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
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
 * @returns {Promise<{ ok: boolean, reason?: string, via?: string, flushed?: unknown, sessionId?: string }>}
 */
export async function wakeSession(ctx, { sessionId, text, preferredId = null } = {}) {
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
    resolved.agent.followup(followupMessage(text))
    let flushed = null
    try {
      const sessions = serviceOf(ctx, 'sessions')
      if (sessions?.flush) flushed = await sessions.flush(resolved.agent.session)
    } catch {
      flushed = false
    }
    return { ok: true, via: 'followup', flushed, sessionId: sid }
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
