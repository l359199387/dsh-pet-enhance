/**
 * 带教过程明细：长期保留，执行时可参考。
 *
 * @module src/coach-log.js
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { learnedPaths } from './learned-automation.js'
import { sessionPaths } from './teach-store.js'

/**
 * @param {string} home
 * @param {string} id
 */
export function coachLogPath(home, id, { learned = false } = {}) {
  if (learned) return join(learnedPaths(home, id).dir, 'coach-log.jsonl')
  return join(sessionPaths(home, id).dir, 'coach-log.jsonl')
}

/**
 * @param {string} home
 * @param {string} id
 * @param {{ kind: string, [k: string]: unknown }} event
 * @param {{ learned?: boolean }} [opts]
 */
export async function appendCoachLog(home, id, event, opts = {}) {
  const path = coachLogPath(home, id, opts)
  await mkdir(join(path, '..'), { recursive: true })
  const row = {
    at: new Date().toISOString(),
    ...event,
  }
  await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8')
  return row
}

/**
 * @param {string} home
 * @param {string} id
 * @param {{ learned?: boolean, limit?: number }} [opts]
 */
export async function readCoachLog(home, id, opts = {}) {
  const path = coachLogPath(home, id, opts)
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 500
  const lines = raw.split(/\n/).filter(Boolean)
  const out = []
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line))
    } catch { /* skip */ }
  }
  return out
}

/**
 * 会话 log 拷到 learned 目录（长期保留）。
 * @param {string} home
 * @param {string} sessionId
 * @param {string} learnedId
 */
export async function promoteCoachLog(home, sessionId, learnedId) {
  const rows = await readCoachLog(home, sessionId, { learned: false })
  if (!rows.length) {
    await appendCoachLog(home, learnedId, {
      kind: 'promote',
      note: 'empty-session-log',
      from: sessionId,
    }, { learned: true })
    return { count: 0 }
  }
  const dest = coachLogPath(home, learnedId, { learned: true })
  await mkdir(join(dest, '..'), { recursive: true })
  const body = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  const { writeFile } = await import('node:fs/promises')
  await writeFile(dest, body, 'utf8')
  return { count: rows.length }
}
