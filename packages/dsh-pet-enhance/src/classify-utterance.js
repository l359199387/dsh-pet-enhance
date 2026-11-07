/**
 * 话语分流：闲聊 / 看屏 / 教学 / 收束 / 干活 / 新开窗。
 *
 * 默认识图用短提示让模型只回一个标签（可扩展，不必为每条学会技能加口令）。
 * 失败再回落本地启发式。禁止指望主会话「带工具分流」——提示里写死禁工具。
 *
 * @module src/classify-utterance.js
 */

import {
  AGENT_WAKE_PREFIX,
  GLANCE_FOLLOWUP_PREFIX,
  TEACH_FOLLOWUP_PREFIX,
  isComputerTaskIntent,
  isGlanceIntent,
  isNewSessionIntent,
  isRunAutomationIntent,
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
  'new_session',
])

const LABEL_SET = new Set(CLASSIFY_LABELS)

/** 仅「问会不会」；不含「去做你学会的…」这类执行口令。 */
const SKILL_STATUS_RE = new RegExp(
  [
    '学会.{0,24}(?:了吗|了没|了嘛|了没呀|了\\?|了？)',
    '(?:会不会|有没有学会|记不记得).{0,24}[吗嘛没？?]?',
    '(?:记得|教过).{0,24}[吗嘛没？?]',
    '你(?:会|能|可以).{0,16}(?:吗|嘛|不|\\?|？)',
  ].join('|'),
)

/**
 * @param {string[] | null | undefined} goals
 * @param {number} [limit]
 */
export function formatLearnedGoalsForClassify(goals, limit = 12) {
  const list = (Array.isArray(goals) ? goals : [])
    .map((g) => String(g ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, limit)
  if (!list.length) return '（暂无已学会条目）'
  return list.map((g, i) => `${i + 1}.「${g.slice(0, 36)}」`).join('；')
}

/**
 * @param {string} userText
 * @param {{ teaching?: boolean, learnedGoals?: string[] }} [opts]
 */
export function buildClassifyPrompt(userText, { teaching = false, learnedGoals = [] } = {}) {
  const clipped = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (teaching) {
    return (
      `${CLASSIFY_PREFIX}`
      + '当前在教学模式。只输出一个标签词，禁止工具与解释：'
      + 'teach_end=教完了/去做/照着做；chat=其他。'
      + `用户：「${clipped}」`
    )
  }
  const learned = formatLearnedGoalsForClassify(learnedGoals)
  return (
    `${CLASSIFY_PREFIX}`
    + '只输出一个标签词，禁止调用任何工具，禁止解释。'
    + 'chat=闲聊问候，或只问「会不会/学会了吗」而不是现在去做；'
    + 'glance=看屏幕/截图/盯着看一会儿；'
    + 'teach=用户要演示教你；teach_end=演示结束；'
    + 'task=要你现在操作电脑，或执行下面已学会的某件事（说法可任意，不必固定口令）；'
    + 'new_session=新开/开启/打开一个新的聊天窗口或新会话（不是闲聊）。'
    + `已学会：${learned}。`
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
  const m = lower.match(/\b(teach_end|teach|glance|task|new_session|chat)\b/)
  if (m && LABEL_SET.has(m[1])) return m[1]

  if (/教完|学完|结束教学|照着做|按刚才/.test(raw)) return 'teach_end'
  if (/教你|跟我学|看我做|开始教学/.test(raw)) return 'teach'
  if (/新开|新会话|新窗口|新聊天/.test(raw)) return 'new_session'
  if (/(?:看(?:一?眼|看)|截图|桌面|屏幕|盯着|陪看|watch)/.test(raw) && !/点|输入|关掉|最小化/.test(raw)) {
    return 'glance'
  }
  if (/干活|任务|操作|点击|输入|执行|去做/.test(raw)) return 'task'
  if (/闲聊|问候|学会了吗|会不会/.test(raw)) return 'chat'
  return null
}

/** 「学会了吗 / 会不会」——问状态，不是下指令。 */
export function isSkillStatusQuestion(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (isRunAutomationIntent(s) || isNewSessionIntent(s)) return false
  return SKILL_STATUS_RE.test(s)
}

/**
 * 极明确口令：本地优先，不交给模型（避免「开启新窗口」被判成闲聊）。
 * @returns {string | null}
 */
export function localClassifyClear(text, { teaching = false } = {}) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (teaching) {
    if (isTeachEndIntent(s) || /按刚才教的|照着做|开始做|你可以去做/.test(s)) return 'teach_end'
    return null
  }
  if (isTeachEndIntent(s)) return 'teach_end'
  if (isTeachStartIntent(s)) return 'teach'
  if (isNewSessionIntent(s)) return 'new_session'
  if (isGlanceIntent(s)) return 'glance'
  return null
}

/**
 * 本地分流（兜底）：明确口令 + 少量执行启发式；闲聊 vs 干活主要交给模型。
 * @param {string} text
 * @param {{ teaching?: boolean }} [opts]
 */
export function localClassify(text, { teaching = false } = {}) {
  const s = String(text ?? '').trim()
  if (!s) return 'chat'
  const clear = localClassifyClear(s, { teaching })
  if (clear) return clear
  if (teaching) return 'chat'
  if (isSkillStatusQuestion(s)) return 'chat'
  // 兜底：仍认一批执行/操作口令，避免模型失败时全变闲聊
  if (isRunAutomationIntent(s) || isComputerTaskIntent(s)) return 'task'
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

/**
 * 默认 hybrid：本地优先，仅模糊「闲聊 vs 干活」才短叫醒。
 * local=只启发式；llm=每句都叫醒（费 token，不推荐）。
 * @returns {'hybrid' | 'llm' | 'local'}
 */
export function classifyMode() {
  const v = String(
    process.env.DSH_PET_ENHANCE_CLASSIFY || process.env.DSH_GLANCE_CLASSIFY || 'hybrid',
  ).trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === 'local' || v === 'regex') {
    return 'local'
  }
  if (v === 'wake' || v === 'llm' || v === 'session' || v === 'model') {
    return 'llm'
  }
  if (v === '1' || v === 'true' || v === 'yes' || v === 'hybrid' || v === 'auto') {
    return 'hybrid'
  }
  return 'hybrid'
}

/** 本地已判 chat，但仍可能是「去做学会的事」时，才值得叫醒模型。 */
export function shouldEscalateChatToModel(text) {
  const s = String(text ?? '').trim()
  if (!s || s.length < 6) return false
  if (isSkillStatusQuestion(s)) return false
  if (/^(你好|嗨|哈喽|在吗|早上好|晚上好|晚安|谢谢|哈哈+)[.。!！?？…]*$/i.test(s)) {
    return false
  }
  // 有一点「去做/帮忙/弄一下」气味，或点到具体主题
  return /(?:帮|请|去|做|弄|跑|执行|打开|记录|看看|刷|聊|写|保存|教过|学会|上次|刚才)/.test(s)
}

/**
 * @param {object | null | undefined} ctx
 * @param {string} userText
 * @param {{
 *   teaching?: boolean,
 *   preferredId?: string | null,
 *   learnedGoals?: string[],
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   complete?: (prompt: string) => Promise<string | null | undefined>,
 *   timeoutMs?: number,
 *   log?: (m: string) => void,
 *   mode?: 'hybrid' | 'llm' | 'local',
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

  // 教/看屏/新开窗等明确口令：本地优先，避免模型误判闲聊
  const clear = localClassifyClear(text, { teaching })
  if (clear) {
    log(`classify → ${clear}（local-clear）`)
    return { label: clear, via: 'local' }
  }

  const localLabel = localClassify(text, { teaching })
  const mode = opts.mode || classifyMode()
  const wantModel = mode === 'llm'
    || (mode === 'hybrid' && localLabel === 'chat' && shouldEscalateChatToModel(text))

  const prompt = buildClassifyPrompt(text, {
    teaching,
    learnedGoals: opts.learnedGoals,
  })

  // 无工具注入（测试 / 外接小模型）
  if (typeof opts.complete === 'function' && wantModel) {
    try {
      const raw = await opts.complete(prompt)
      const label = parseClassifyLabel(raw)
      if (label) return { label, via: 'inject', raw: String(raw ?? '') }
    } catch (e) {
      log(`classify inject 失败：${e?.message ?? e}`)
    }
  }

  // 仅 llm / hybrid 模糊句才短叫醒；失败回落本地
  if (wantModel && ctx) {
    const wake = opts.wake ?? wakeSession
    const waitReply = opts.waitReply ?? waitAssistantReply
    try {
      const woken = await wake(ctx, {
        text: prompt,
        preferredId: opts.preferredId ?? null,
        log,
      })
      if (woken.ok && woken.sessionId) {
        const reply = await waitReply(ctx, woken.sessionId, {
          timeoutMs: opts.timeoutMs ?? 8_000,
          pollMs: 350,
        })
        if (reply.ok && reply.text) {
          const label = parseClassifyLabel(reply.text)
          if (label) {
            log(`classify → ${label}（llm/${mode}）`)
            return { label, via: 'llm', raw: reply.text }
          }
          log(`classify llm 回复无法解析：${String(reply.text).slice(0, 60)}`)
        } else {
          log(`classify llm 无回复：${reply.reason || 'timeout'}`)
        }
      } else {
        log(`classify llm 叫醒失败：${woken.reason || 'unknown'}`)
      }
    } catch (e) {
      log(`classify llm 异常：${e?.message ?? e}`)
    }
  }

  log(`classify → ${localLabel}（local）`)
  return { label: localLabel, via: 'local' }
}
