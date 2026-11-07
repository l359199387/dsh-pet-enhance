/**
 * 极低成本话语分流：闲聊 / 看屏 / 教学 / 收束 / 干活。
 *
 * 默认走本地启发式（0 token，不叫醒主会话）。
 * 禁止把分流提示 followup 进带工具的主会话——否则会当任务去 click（已踩坑）。
 *
 * 可选：注入无工具的 `complete(prompt)`；仅当 `DSH_PET_ENHANCE_CLASSIFY=wake` 才允许危险的主会话叫醒。
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

const SKILL_STATUS_RE = new RegExp(
  [
    '学会.{0,24}(?:了吗|了没|了嘛|了没呀|了\\?|了？)',
    '(?:会不会|有没有学会|记不记得|教过)',
    '(?:记得|教过).{0,24}[吗嘛没]',
    '你(?:会|能|可以).{0,16}(?:吗|嘛|不|\\?|？)',
  ].join('|'),
)

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
    + 'chat=闲聊问候或询问是否学会；glance=看屏幕/截图/盯着看一会儿；'
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

  if (/教完|学完|结束教学|照着做|按刚才/.test(raw)) return 'teach_end'
  if (/教你|跟我学|看我做|开始教学/.test(raw)) return 'teach'
  if (/(?:看(?:一?眼|看)|截图|桌面|屏幕|盯着|陪看|watch)/.test(raw) && !/点|输入|关掉|最小化/.test(raw)) {
    return 'glance'
  }
  if (/干活|任务|操作|点击|输入/.test(raw)) return 'task'
  if (/闲聊|聊天|问候|学会/.test(raw)) return 'chat'
  return null
}

/** 「学会了吗 / 会不会」——问状态，不是下指令。 */
export function isSkillStatusQuestion(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  return SKILL_STATUS_RE.test(s)
}

/**
 * 本地分流（主路径，0 token）。
 * @param {string} text
 * @param {{ teaching?: boolean }} [opts]
 */
export function localClassify(text, { teaching = false } = {}) {
  const s = String(text ?? '').trim()
  if (!s) return 'chat'
  if (teaching) {
    if (isTeachEndIntent(s) || /按刚才教的|照着做|开始做|你可以去做/.test(s)) return 'teach_end'
    return 'chat'
  }
  if (isTeachEndIntent(s)) return 'teach_end'
  if (isTeachStartIntent(s)) return 'teach'
  // 先拦「学会了吗」类，避免被 task 粗筛误伤
  if (isSkillStatusQuestion(s)) return 'chat'
  // 「执行一下记录每日心情 / 去记录一下…」→ task，走已学自动化
  if (isComputerTaskIntent(s)) return 'task'
  if (isGlanceIntent(s)) return 'glance'
  return 'chat'
}

/** @deprecated 用 localClassify */
export function regexClassifyFallback(text, opts) {
  return localClassify(text, opts)
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

/** 默认 local；wake 仅显式开启（会污染主会话，不推荐）。 */
function classifyMode() {
  const v = String(
    process.env.DSH_PET_ENHANCE_CLASSIFY || process.env.DSH_GLANCE_CLASSIFY || 'local',
  ).trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === 'local' || v === 'regex') {
    return 'local'
  }
  if (v === 'wake' || v === 'llm' || v === 'session') return 'wake'
  if (v === '1' || v === 'true' || v === 'yes') return 'local' // 旧默认曾误用 wake，现一律 local
  return 'local'
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
 * @returns {Promise<{ label: string, via: 'llm' | 'regex' | 'inject' | 'local', raw?: string }>}
 */
export async function classifyUtterance(ctx, userText, opts = {}) {
  const teaching = Boolean(opts.teaching)
  const log = opts.log ?? (() => {})
  const text = String(userText ?? '').trim()
  if (!text || isClassifyEcho(text)) {
    return { label: 'chat', via: 'local' }
  }

  const prompt = buildClassifyPrompt(text, { teaching })

  // 无工具注入（测试 / 将来接小模型）
  if (typeof opts.complete === 'function') {
    try {
      const raw = await opts.complete(prompt)
      const label = parseClassifyLabel(raw)
      if (label) return { label, via: 'inject', raw: String(raw ?? '') }
    } catch (e) {
      log(`classify inject 失败：${e?.message ?? e}`)
    }
  }

  // 显式才允许叫醒主会话（默认关闭：会触发工具、浪费 token）
  if (classifyMode() === 'wake' && ctx) {
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
            log(`classify → ${label}（wake）`)
            return { label, via: 'llm', raw: reply.text }
          }
        }
      }
    } catch (e) {
      log(`classify wake 异常：${e?.message ?? e}`)
    }
  }

  const label = localClassify(text, { teaching })
  log(`classify → ${label}（local）`)
  return { label, via: 'local' }
}
