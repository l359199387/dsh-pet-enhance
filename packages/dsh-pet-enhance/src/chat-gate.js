/**
 * dsh-pet 对话闸门：任务/看屏/教学由插件接手，避免小蓝鲸先嘴炮「已打开/已保存」。
 *
 * @module src/chat-gate.js
 */

import { classifyUtterance } from './classify-utterance.js'
import { t } from './i18n.js'
import { getLocale } from './settings.js'

/** 需要插件接手、跳过 dsh-pet 闲聊模型的标签。 */
export const TAKEOVER_LABELS = new Set(['task', 'glance', 'teach', 'teach_end'])

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
export function ackForLabel(label, locale = 'zh') {
  const loc = locale || 'zh'
  switch (label) {
    case 'glance':
      return '好，我瞅一眼…'
    case 'teach':
      return '好，你演示，我学。'
    case 'teach_end':
      return '好，我按刚才学的去做…'
    case 'task':
      return t(loc, 'bubble.taskTakeover')
    default:
      return ''
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
 *     stopAndRun: Function,
 *     tryRunMatchingPlaybook?: (text: string) => Promise<boolean>,
 *   },
 *   getPreferredSessionId?: () => string | null,
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
  const { label, via } = await classify(options.ctx, text, {
    teaching,
    preferredId,
    log,
  })

  if (!shouldTakeoverChat(label) && !teaching) {
    return { ok: true, takeover: false, label, via }
  }

  const locale = getLocale(options.home)
  const effectiveLabel = teaching && (label === 'teach_end' || label === 'task') ? 'teach_end' : label
  const ack = ackForLabel(effectiveLabel, locale)

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
    if (label === 'teach_end' || label === 'task') {
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
    default:
      break
  }
}
