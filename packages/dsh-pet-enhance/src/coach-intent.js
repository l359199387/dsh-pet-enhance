/**
 * 对话带教意图：做成了 / 纠正继续 / 放弃 / 继续指引。
 * **禁止**用用户口令正则写死；与 classify-utterance 一样，短提示让模型判标签。
 *
 * @module src/coach-intent.js
 */

import { wakeSession, waitAssistantReply } from './wake-session.js'

/** 带教中分流前缀——不得再被当成用户话。 */
export const COACH_CLASSIFY_PREFIX = '【小蓝鲸带教分流】'

export const COACH_LABELS = Object.freeze(['done', 'abort', 'correct', 'guide'])

const LABEL_SET = new Set(COACH_LABELS)

/**
 * @param {string} userText
 * @param {{ goal?: string }} [opts]
 */
export function buildCoachClassifyPrompt(userText, opts = {}) {
  const clipped = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const goal = String(opts.goal || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return (
    `${COACH_CLASSIFY_PREFIX}`
    + '当前正在对话带教。只输出一个标签词，禁止工具与解释。\n'
    + 'done=主人认为已经做成/可以记成学会了；\n'
    + 'abort=主人要放弃/取消本轮带教；\n'
    + 'correct=主人在纠正做法、指出不对、要求重来或改步骤（同会话继续）；\n'
    + 'guide=继续说明目标、补充细节、或普通带教对话（既非做成也非放弃）。\n'
    + '根据语义理解，不要死抠固定口令。\n'
    + (goal ? `带教目标：「${goal}」。\n` : '')
    + `用户：「${clipped}」`
  )
}

/**
 * 从模型短回复抠标签（解析模型输出，不是匹配用户口令）。
 * @param {string} reply
 * @returns {'done' | 'abort' | 'correct' | 'guide' | null}
 */
export function parseCoachClassifyLabel(reply) {
  const raw = String(reply ?? '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  const m = lower.match(/\b(done|abort|correct|guide)\b/)
  if (m && LABEL_SET.has(m[1])) return /** @type {'done'|'abort'|'correct'|'guide'} */ (m[1])

  // 模型偶发中文标签
  if (/^(?:做成|完成|学会|记下来|可以落盘)/m.test(raw)) return 'done'
  if (/^(?:放弃|取消|不教)/m.test(raw)) return 'abort'
  if (/^(?:纠正|不对|重来|继续改)/m.test(raw)) return 'correct'
  if (/^(?:指引|继续|说明|补充)/m.test(raw)) return 'guide'
  return null
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
 * @returns {Promise<'done' | 'abort' | 'correct' | 'guide'>}
 */
export async function classifyCoachUtterance(ctx, userText, opts = {}) {
  const log = opts.log ?? (() => {})
  const s = String(userText ?? '').trim()
  if (!s) return 'guide'

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
      log(`coach-classify 叫醒失败：${woken.reason || 'unknown'} → guide`)
      return 'guide'
    }
    const reply = await waitReply(ctx, woken.sessionId, {
      timeoutMs: opts.timeoutMs ?? 20_000,
    })
    if (!reply.ok || !reply.text) {
      log(`coach-classify 无回复：${reply.reason || 'empty'} → guide`)
      return 'guide'
    }
    const label = parseCoachClassifyLabel(reply.text)
    if (label) {
      log(`coach-classify → ${label}`)
      return label
    }
    log(`coach-classify 无法解析：${String(reply.text).slice(0, 60)} → guide`)
    return 'guide'
  } catch (e) {
    log(`coach-classify 异常：${e?.message ?? e} → guide`)
    return 'guide'
  }
}
