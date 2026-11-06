/**
 * 两步确认闸门：L2/L3 必须用户点按钮；模型不能自证已确认。
 *
 * @module src/confirm.js
 */

import { randomUUID } from 'node:crypto'
import { CONFIRM_TIMEOUT_MS } from './policy.js'

/**
 * @param {{
 *   timeoutMs?: number,
 *   onPending?: (pending: object | null) => void,
 *   log?: (m: string) => void,
 * }} [options]
 */
export function createConfirmGate(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : CONFIRM_TIMEOUT_MS
  const log = options.log ?? (() => {})
  /** @type {Map<string, { resolve: (v: object) => void, timer: NodeJS.Timeout, entry: object }>} */
  const waiting = new Map()

  function publish(entry) {
    try { options.onPending?.(entry) } catch { /* ignore */ }
  }

  function finish(id, allow, via) {
    const row = waiting.get(id)
    if (!row) return false
    waiting.delete(id)
    clearTimeout(row.timer)
    publish(waiting.size ? [...waiting.values()].at(-1).entry : null)
    row.resolve({ allow: Boolean(allow), via, id })
    return true
  }

  /**
   * 等待用户确认。超时 = 拒绝。
   * @param {{ summary: string, tier: string, action?: object }} spec
   * @returns {Promise<{ allow: boolean, via: string, id: string }>}
   */
  function ask(spec) {
    const id = randomUUID()
    const entry = {
      id,
      summary: String(spec.summary ?? '').slice(0, 240),
      tier: String(spec.tier ?? 'L2'),
      action: spec.action ?? null,
      at: new Date().toISOString(),
      timeoutMs,
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log(`确认超时拒绝：${id}`)
        finish(id, false, 'timeout')
      }, timeoutMs)
      waiting.set(id, { resolve, timer, entry })
      publish(entry)
      log(`等待确认 ${entry.tier}：${entry.summary}`)
    })
  }

  /**
   * HTTP / 菜单回执。
   * @param {string} id
   * @param {boolean} allow
   */
  function resolve(id, allow) {
    const ok = finish(String(id ?? ''), Boolean(allow), allow ? 'user-allow' : 'user-deny')
    if (!ok) log(`确认回执无效或已过期：${id}`)
    return ok
  }

  /** 急停：所有挂起确认一律拒绝。 */
  function cancelAll(via = 'panic') {
    const ids = [...waiting.keys()]
    for (const id of ids) finish(id, false, via)
  }

  function getPending() {
    if (!waiting.size) return null
    return [...waiting.values()].at(-1).entry
  }

  return { ask, resolve, cancelAll, getPending, timeoutMs }
}
