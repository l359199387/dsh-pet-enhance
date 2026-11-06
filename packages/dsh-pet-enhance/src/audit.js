/**
 * 动作审计：`~/.dsh/pet-enhance/actions.jsonl`（只记参数与结果，不记截图内容）。
 *
 * @module src/audit.js
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export function actionsFilePath(home) {
  return join(home, 'actions.jsonl')
}

/**
 * @param {object} partial
 * @returns {object}
 */
export function buildActionRecord(partial = {}) {
  return {
    at: partial.at ?? new Date().toISOString(),
    tool: partial.tool ?? 'act',
    action: partial.action ?? null,
    args: partial.args ?? {},
    tier: partial.tier ?? null,
    confirmed: partial.confirmed ?? null,
    ok: Boolean(partial.ok),
    code: partial.code ?? null,
    ms: partial.ms ?? null,
    screen: partial.screen ?? null,
    window: partial.window ?? null,
    before: partial.before ?? null,
    after: partial.after ?? null,
    maybeNoop: partial.maybeNoop ?? false,
    reason: partial.reason ?? undefined,
  }
}

/**
 * @param {string} home
 * @param {object} record
 */
export async function appendAction(home, record) {
  const dir = home
  await mkdir(dir, { recursive: true })
  const line = `${JSON.stringify(buildActionRecord(record))}\n`
  await appendFile(actionsFilePath(home), line, 'utf8')
}
