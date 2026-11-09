/**
 * 对话带教意图：一律短提示让模型判标签 / 抽目标。
 * 禁止用用户口令正则写死 done/abort/step/open 等。
 *
 * @module src/coach-intent.js
 */

import { wakeSession, waitAssistantReply } from './wake-session.js'

/** 带教中分流前缀——不得再被当成用户话。 */
export const COACH_CLASSIFY_PREFIX = '【小蓝鲸带教分流】'

export const COACH_GOAL_PREFIX = '【小蓝鲸带教抽目标】'

/**
 * done=做成可落盘；abort=放弃；correct=纠正本步；
 * step=给出可执行的本步指示（应动手）；open=开场/只定目标/尚无具体一步（勿动手）。
 */
export const COACH_LABELS = Object.freeze(['done', 'abort', 'correct', 'step', 'open'])

const LABEL_SET = new Set(COACH_LABELS)

/**
 * @param {string} userText
 * @param {{ goal?: string }} [opts]
 */
export function buildCoachClassifyPrompt(userText, opts = {}) {
  const clipped = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const goal = String(opts.goal || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return (
    `${COACH_CLASSIFY_PREFIX}`
    + '当前正在对话带教。只输出一个英文标签词，禁止工具与解释、禁止中文标签。\n'
    + 'done=主人认为已经做成、可以记成学会；\n'
    + 'abort=主人要放弃/取消本轮带教；\n'
    + 'correct=主人在纠正刚才做法、要求改这一步；\n'
    + 'step=主人给出了本步可执行指示（应动手做这一小步）；\n'
    + 'open=开场、宣布开课、只说总目标、或还没有具体可执行步骤（不要动手）。\n'
    + '根据语义理解归类，不要死抠固定口令。\n'
    + (goal ? `已知带教总目标：「${goal}」。\n` : '尚未锁定总目标。\n')
    + `用户：「${clipped}」`
  )
}

/**
 * 从用户开场话抽出总目标（模型理解，非正则剥离）。
 * @param {string} userText
 */
export function buildCoachGoalExtractPrompt(userText) {
  const clipped = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return (
    `${COACH_GOAL_PREFIX}`
    + '用户在开始对话带教。请理解他真正要教的总目标（一件事），去掉「我教你/开始教」等套话。\n'
    + '只输出一行：\n'
    + 'GOAL: <不超过40字的目标>\n'
    + '禁止工具与解释。\n'
    + `用户：「${clipped}」`
  )
}

/**
 * 解析模型输出的标签（只认模型回复格式，不匹配用户原话口令）。
 * @param {string} reply
 * @returns {'done'|'abort'|'correct'|'step'|'open'|null}
 */
export function parseCoachClassifyLabel(reply) {
  const raw = String(reply ?? '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  const m = lower.match(/\b(done|abort|correct|step|open)\b/)
  if (m && LABEL_SET.has(m[1])) return /** @type {'done'|'abort'|'correct'|'step'|'open'} */ (m[1])
  // 兼容旧 guide → open（过渡）
  if (/\bguide\b/.test(lower)) return 'open'
  return null
}

/**
 * @param {string} reply
 * @returns {string}
 */
export function parseCoachGoalReply(reply) {
  const raw = String(reply ?? '').trim()
  if (!raw) return ''
  const m = raw.match(/GOAL\s*[:：]\s*(.+)/i)
  let body = (m ? m[1] : raw.split(/\n/)[0] || '').trim()
  body = body.replace(/^["「]|["」]$/g, '').trim()
  return body.slice(0, 80)
}

/**
 * @param {object} ctx
 * @param {string} userText
 * @param {{
 *   goal?: string,
 *   preferredId?: string | null,
 *   log?: (m: string) => void,
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {Promise<'done'|'abort'|'correct'|'step'|'open'>}
 */
export async function classifyCoachUtterance(ctx, userText, opts = {}) {
  const log = opts.log ?? (() => {})
  const s = String(userText ?? '').trim()
  if (!s) return 'open'

  const wake = opts.wake ?? wakeSession
  const waitReply = opts.waitReply ?? waitAssistantReply
  const prompt = buildCoachClassifyPrompt(s, { goal: opts.goal })

  try {
    const woken = await wake(ctx, {
      text: prompt,
      preferredId: opts.preferredId || null,
      log,
    })
    if (!woken.ok) {
      log(`coach-classify 叫醒失败：${woken.reason || 'unknown'} → open`)
      return 'open'
    }
    const reply = await waitReply(ctx, woken.sessionId, {
      timeoutMs: opts.timeoutMs ?? 20_000,
    })
    if (!reply.ok || !reply.text) {
      log(`coach-classify 无回复：${reply.reason || 'empty'} → open`)
      return 'open'
    }
    const label = parseCoachClassifyLabel(reply.text)
    if (label) {
      log(`coach-classify → ${label}`)
      return label
    }
    log(`coach-classify 无法解析：${String(reply.text).slice(0, 60)} → open`)
    return 'open'
  } catch (e) {
    log(`coach-classify 异常：${e?.message ?? e} → open`)
    return 'open'
  }
}

/**
 * @param {object} ctx
 * @param {string} userText
 * @param {{
 *   preferredId?: string | null,
 *   log?: (m: string) => void,
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   timeoutMs?: number,
 *   fallback?: string,
 * }} [opts]
 */
export async function extractCoachGoal(ctx, userText, opts = {}) {
  const log = opts.log ?? (() => {})
  const fallback = String(opts.fallback || '完成主人要教的这件事').slice(0, 80)
  const s = String(userText ?? '').trim()
  if (!s) return fallback

  const wake = opts.wake ?? wakeSession
  const waitReply = opts.waitReply ?? waitAssistantReply

  try {
    const woken = await wake(ctx, {
      text: buildCoachGoalExtractPrompt(s),
      preferredId: opts.preferredId || null,
      log,
    })
    if (!woken.ok) {
      log(`coach-goal 叫醒失败：${woken.reason || 'unknown'}`)
      return fallback
    }
    const reply = await waitReply(ctx, woken.sessionId, {
      timeoutMs: opts.timeoutMs ?? 20_000,
    })
    const goal = parseCoachGoalReply(reply.ok ? reply.text : '')
    if (goal) {
      log(`coach-goal → ${goal}`)
      return goal
    }
    return fallback
  } catch (e) {
    log(`coach-goal 异常：${e?.message ?? e}`)
    return fallback
  }
}
