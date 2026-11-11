/**
 * dsh-pet 对话闸门：任务/看屏/教学由插件接手；纯闲聊放行 dsh-pet 闲聊模型。
 *
 * @module src/chat-gate.js
 */

import { classifyUtterance, isSkillStatusQuestion } from './classify-utterance.js'
import { isRunAutomationIntent, isWatchIntent, parseWatchSeconds } from './intent.js'
import { listLearnedIndex } from './learned-automation.js'
import { listSkillGoals, listTeachSkills } from './skill-match.js'
import { mnemonBubbleSuffix } from './teach-skill.js'
import { sayConclusionToPet } from './pet-chat-memory.js'
import { t } from './i18n.js'
import { getLocale } from './settings.js'

/** 需要插件接手、跳过 dsh-pet 闲聊模型的标签（不含 chat：闲聊放行）。 */
export const TAKEOVER_LABELS = new Set([
  'task', 'glance', 'teach', 'teach_end', 'teach_coach', 'new_session',
])

/**
 * @param {string} label
 */
export function shouldTakeoverChat(label) {
  return TAKEOVER_LABELS.has(String(label || ''))
}

/**
 * @param {string} label
 * @param {string} [locale]
 */
export function ackForLabel(label, locale = 'zh', text = '') {
  const loc = locale || 'zh'
  switch (label) {
    case 'glance':
      if (isWatchIntent(text)) {
        const sec = parseWatchSeconds(text, 60)
        return `好，我盯大约 ${sec} 秒；有变化再跟你说，先别急。`
      }
      return '好，我瞅一眼…'
    case 'teach':
      return '好，一步一步教：你说这一步，我只做这一步。'
    case 'teach_coach':
      return '嗯，我听着呢…'
    case 'teach_end':
      return '好，我按刚才学的去做…'
    case 'task':
      return t(loc, 'bubble.taskTakeover')
    case 'new_session':
      return '好，我新开一个工作区聊天窗…'
    case 'chat':
      return ''
    default:
      return t(loc, 'bubble.taskTakeover')
  }
}

/**
 * @param {{
 *   ctx: object,
 *   home: string,
 *   text: string,
 *   log?: (m: string) => void,
 *   chatBridge?: { handleIntent: Function },
 *   agentBridge?: { handleTask: Function },
 *   teachBridge?: {
 *     isTeaching: () => boolean,
 *     startTeaching: Function,
 *     stopAndRun?: Function,
 *     handleCoachUtterance?: (text: string) => Promise<unknown>,
 *     tryRunMatchingPlaybook?: (text: string) => Promise<boolean>,
 *   },
 *   getPreferredSessionId?: () => string | null,
 *   openNewSession?: (text: string) => Promise<unknown>,
 *   classify?: typeof classifyUtterance,
 *   markHandled?: (text: string) => void,
 * }} options
 */
export async function runChatGate(options) {
  const text = String(options.text ?? '').trim()
  if (!text) {
    return { ok: true, takeover: false, label: 'chat', via: 'empty' }
  }

  const teaching = Boolean(options.teachBridge?.isTeaching?.())
  const preferredId = options.getPreferredSessionId?.() ?? null
  const classify = options.classify ?? classifyUtterance
  const log = options.log ?? (() => {})
  /** @type {string[]} */
  let learnedGoals = []
  if (!teaching) {
    try {
      learnedGoals = await listSkillGoals()
      if (!learnedGoals.length && options.home) {
        const list = await listLearnedIndex(options.home)
        learnedGoals = (list || [])
          .slice(0, 12)
          .map((r) => String(r.goal || '').trim())
          .filter(Boolean)
      }
    } catch { /* ignore */ }
  }
  const { label, via } = await classify(options.ctx, text, {
    teaching,
    preferredId,
    learnedGoals,
    log,
  })

  // 纯闲聊放行 dsh-pet；「学会了吗 / 执行学会的」仍接管（避免双回复或漏跑）
  if (label === 'chat' && !teaching) {
    const needPlugin = isSkillStatusQuestion(text) || isRunAutomationIntent(text)
    if (!needPlugin) {
      return { ok: true, takeover: false, label: 'chat', via }
    }
  } else if (!shouldTakeoverChat(label) && !teaching) {
    return { ok: true, takeover: false, label, via }
  }

  const locale = getLocale(options.home)
  const effectiveLabel = teaching
    ? (label === 'teach_coach' || label === 'teach_end' || label === 'task' || label === 'chat'
      ? 'teach_coach'
      : label)
    : label
  const ack = ackForLabel(effectiveLabel, locale, text)

  // 客户端闸门 + 服务端闸门可能连打两次：短时去重，只派发一次
  const dup = Boolean(options.isDuplicate?.(text))
  if (!dup) {
    try { options.markHandled?.(text) } catch { /* ignore */ }
    queueMicrotask(() => {
      dispatchTakeover(options, label, text, teaching).catch((e) => {
        log(`chat-gate 执行失败：${e?.message ?? e}`)
      })
    })
  }

  log(`chat-gate：takeover ${via}/${effectiveLabel}${dup ? '（去重）' : ''}`)
  return { ok: true, takeover: true, label: effectiveLabel, via: dup ? 'dedupe' : via, ack }
}

/**
 * @param {object} options
 * @param {string} label
 * @param {string} text
 * @param {boolean} teaching
 */
async function dispatchTakeover(options, label, text, teaching) {
  if (teaching) {
    if (typeof options.teachBridge?.handleCoachUtterance === 'function') {
      await options.teachBridge.handleCoachUtterance(text)
    } else if (label === 'teach_end' || label === 'task') {
      await options.teachBridge?.stopAndRun?.()
    }
    return
  }
  switch (label) {
    case 'glance':
      await options.chatBridge?.handleIntent?.(text)
      break
    case 'teach':
      await options.teachBridge?.startTeaching?.(text)
      break
    case 'teach_end':
      await options.teachBridge?.stopAndRun?.()
      break
    case 'task': {
      const ran = await options.teachBridge?.tryRunMatchingPlaybook?.(text)
      if (!ran) await options.agentBridge?.handleTask?.(text)
      break
    }
    case 'new_session':
      await options.openNewSession?.(text)
      break
    case 'chat':
    default: {
      // 仅在「学会了吗 / 执行口令」等强制接管时进入；纯闲聊不会走到这里
      if (isRunAutomationIntent(text)) {
        const ran = await options.teachBridge?.tryRunMatchingPlaybook?.(text)
        if (ran) break
      }
      if (await answerSkillStatusInGate(options, text)) break
      const ran = await options.teachBridge?.tryRunMatchingPlaybook?.(text)
      if (ran) break
      break
    }
  }
}

/**
 * 「学会了吗」本地作答（不叫醒闲聊模型）。
 * @returns {Promise<boolean>}
 */
async function answerSkillStatusInGate(options, userText) {
  if (!isSkillStatusQuestion(userText)) return false
  if (isRunAutomationIntent(userText)) return false
  const pet = options.petId || 'main'
  const list = await listTeachSkills()
  const q = String(userText).toLowerCase()
  if (!list.length) {
    await sayConclusionToPet(
      `还没学会呢。对我说「我教你…」，做成了后会写入本机技能。${mnemonBubbleSuffix()}`,
      { pet, duration: 14_000, memoryPath: options.petMemoryPath },
    )
    return true
  }
  const hit = list.find((row) => {
    const goal = String(row.goal || '').trim()
    if (!goal) return false
    const g = goal.toLowerCase()
    return q.includes(g) || g.split(/[\s，,。、]+/).filter((t) => t.length >= 2).some((tok) => q.includes(tok))
  })
  if (hit) {
    await sayConclusionToPet(
      `学会了「${String(hit.goal).slice(0, 40)}」（技能 ${hit.name}）。要我跑一次吗？${mnemonBubbleSuffix()}`,
      { pet, duration: 12_000, memoryPath: options.petMemoryPath },
    )
  } else {
    const recent = list.slice(0, 3).map((r) => `「${String(r.goal || '?').slice(0, 24)}」`).join('、')
    await sayConclusionToPet(
      `这件事我还没学会。最近技能：${recent || '（空）'}。想教我直接说。`,
      { pet, duration: 14_000, memoryPath: options.petMemoryPath },
    )
  }
  return true
}
