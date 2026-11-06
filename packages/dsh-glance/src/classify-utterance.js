/**
 * 极低 token 的话语分流：闲聊 / 看屏 / 教学 / 收束 / 干活。
 *
 * 设计目标：每次对小蓝鲸说话都先过一次模型判断，而不是靠固定激活词。
 * 提示极短（用户话截断 ~100 字），并禁止调工具；失败时才回落到本地粗筛。
 *
 * @module src/classify-utterance.js
 */

import {
  AGENT_WAKE_PREFIX,
  GLANCE_FOLLOWUP_PREFIX,
  TEACH_FOLLOWUP_PREFIX,
  isComputerTaskIntent,
  isGlanceIntent,
  isTeachEndIntent,
  isTeachStartIntent,
} from './intent.js'
import { wakeSession, waitAssistantReply } from './wake-session.js'

/** 分流跟催前缀——不得再被当成用户话。 */
export const CLASSIFY_PREFIX = '【小蓝鲸分流】'

export const CLASSIFY_LABELS = Object.freeze([
  'chat',
  'glance',
  'teach',
  'teach_end',
  'task',
])

const LABEL_SET = new Set(CLASSIFY_LABELS)

/**
 * @param {string} userText
 * @param {{ teaching?: boolean }} [opts]
 */
export function buildClassifyPrompt(userText, { teaching = false } = {}) {
  const clipped = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
  if (teaching) {
    return (
      `${CLASSIFY_PREFIX}`
      + '当前在教学模式。只输出一个标签，禁止工具与解释：'
      + 'teach_end=教完了/去做/照着做；chat=其他。'
      + `用户：「${clipped}」`
    )
  }
  return (
    `${CLASSIFY_PREFIX}`
    + '只输出一个标签词，禁止工具与解释。'
    + 'chat=闲聊问候；glance=看屏幕/截图；'
    + 'teach=用户要演示教你；teach_end=演示结束要你照做；'
    + 'task=要你操作电脑。'
    + `用户：「${clipped}」`
  )
}

/**
 * 从模型短回复里抠出标签。
 * @param {string} reply
 * @returns {string | null}
 */
export function parseClassifyLabel(reply) {
  const raw = String(reply ?? '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  const m = lower.match(/\b(teach_end|teach|glance|task|chat)\b/)
  if (m && LABEL_SET.has(m[1])) return m[1]

  // 偶发中文整句
  if (/教完|学完|结束教学|照着做|按刚才/.test(raw)) return 'teach_end'
  if (/教你|跟我学|看我做|开始教学/.test(raw)) return 'teach'
  if (/看(?:一?眼|看)|截图|桌面|屏幕/.test(raw) && !/点|输入|关掉|最小化/.test(raw)) return 'glance'
  if (/干活|任务|操作|点击|输入/.test(raw)) return 'task'
  if (/闲聊|聊天|问候/.test(raw)) return 'chat'
  return null
}

/**
 * 无模型时的本地粗筛（仅兜底，不是主路径）。
 * @param {string} text
 * @param {{ teaching?: boolean }} [opts]
 */
export function regexClassifyFallback(text, { teaching = false } = {}) {
  const s = String(text ?? '').trim()
  if (!s) return 'chat'
  if (teaching) {
    if (isTeachEndIntent(s) || /按刚才教的|照着做|开始做/.test(s)) return 'teach_end'
    return 'chat'
  }
  if (isTeachEndIntent(s)) return 'teach_end'
  if (isTeachStartIntent(s)) return 'teach'
  if (isComputerTaskIntent(s)) return 'task'
  if (isGlanceIntent(s)) return 'glance'
  return 'chat'
}

export function isClassifyEcho(text) {
  const s = String(text ?? '')
  return (
    s.startsWith(CLASSIFY_PREFIX)
    || s.startsWith(GLANCE_FOLLOWUP_PREFIX)
    || s.startsWith(AGENT_WAKE_PREFIX)
    || s.includes(TEACH_FOLLOWUP_PREFIX)
  )
}

function classifyDisabled() {
  const v = String(process.env.DSH_GLANCE_CLASSIFY || '1').trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off' || v === 'no'
}

/**
 * @param {object | null | undefined} ctx
 * @param {string} userText
 * @param {{
 *   teaching?: boolean,
 *   preferredId?: string | null,
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   complete?: (prompt: string) => Promise<string | null | undefined>,
 *   timeoutMs?: number,
 *   log?: (m: string) => void,
 * }} [opts]
 * @returns {Promise<{ label: string, via: 'llm' | 'regex' | 'inject', raw?: string }>}
 */
export async function classifyUtterance(ctx, userText, opts = {}) {
  const teaching = Boolean(opts.teaching)
  const log = opts.log ?? (() => {})
  const text = String(userText ?? '').trim()
  if (!text || isClassifyEcho(text)) {
    return { label: 'chat', via: 'regex' }
  }

  const prompt = buildClassifyPrompt(text, { teaching })

  if (typeof opts.complete === 'function') {
    try {
      const raw = await opts.complete(prompt)
      const label = parseClassifyLabel(raw)
      if (label) return { label, via: 'inject', raw: String(raw ?? '') }
    } catch (e) {
      log(`classify inject 失败：${e?.message ?? e}`)
    }
  }

  if (!classifyDisabled() && ctx) {
    const wake = opts.wake ?? wakeSession
    const waitReply = opts.waitReply ?? waitAssistantReply
    try {
      const woken = await wake(ctx, {
        text: prompt,
        preferredId: opts.preferredId ?? null,
      })
      if (woken.ok && woken.sessionId) {
        const reply = await waitReply(ctx, woken.sessionId, {
          timeoutMs: opts.timeoutMs ?? 20_000,
          pollMs: 400,
        })
        if (reply.ok && reply.text) {
          const label = parseClassifyLabel(reply.text)
          if (label) {
            log(`classify → ${label}（llm）`)
            return { label, via: 'llm', raw: reply.text }
          }
          log(`classify 解析失败，回落 regex：${String(reply.text).slice(0, 40)}`)
        } else {
          log(`classify 等待失败：${reply.reason || 'empty'}`)
        }
      } else {
        log(`classify 叫醒失败：${woken.reason || 'unknown'}`)
      }
    } catch (e) {
      log(`classify 异常：${e?.message ?? e}`)
    }
  }

  const label = regexClassifyFallback(text, { teaching })
  log(`classify → ${label}（regex）`)
  return { label, via: 'regex' }
}
