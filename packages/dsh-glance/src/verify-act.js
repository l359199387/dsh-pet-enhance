/**
 * 动作后本地验证：对比动作前后缩略指纹；完全一样则标「可能没生效」。
 *
 * @module src/verify-act.js
 */

import { createHash } from 'node:crypto'

const VERIFY_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'drag', 'type', 'key',
])

/**
 * @param {string | Buffer | null | undefined} payload
 */
export function hashPayload(payload) {
  if (payload == null || payload === '') return null
  const buf = typeof payload === 'string' ? Buffer.from(payload) : payload
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`
}

/**
 * @param {{ call: Function } | null | undefined} sidecar
 * @param {number} [timeoutMs]
 * @returns {Promise<string | null>}
 */
export async function captureScreenFingerprint(sidecar, timeoutMs = 8_000) {
  if (!sidecar || typeof sidecar.call !== 'function') return null
  try {
    const resp = await sidecar.call(
      'capture',
      { source: { kind: 'screen' }, max_width: 96 },
      timeoutMs,
    )
    if (!resp?.ok || !resp?.png) return null
    return hashPayload(resp.png)
  } catch {
    return null
  }
}

/**
 * @param {string} action
 */
export function shouldVerifyAction(action) {
  return VERIFY_ACTIONS.has(String(action ?? '').toLowerCase())
}

/**
 * @param {string | null} before
 * @param {string | null} after
 * @returns {{ maybeNoop: boolean, before: string | null, after: string | null }}
 */
export function compareFingerprints(before, after) {
  if (!before || !after) {
    return { maybeNoop: false, before: before ?? null, after: after ?? null }
  }
  return {
    maybeNoop: before === after,
    before,
    after,
  }
}
