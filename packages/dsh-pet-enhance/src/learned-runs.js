/**
 * 学会条目的执行记录：落盘、列表、评价写回。
 *
 * ~/.dsh/pet-enhance/learned/<id>/runs.json
 *
 * @module src/learned-runs.js
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { learnedPaths } from './learned-automation.js'

export const MAX_LEARNED_RUNS = 40

export const RATING_LABELS = {
  good: '好',
  ok: '一般',
  bad: '差',
}

export function learnedRunsPath(home, id) {
  return join(learnedPaths(home, id).dir, 'runs.json')
}

function newRunId() {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

async function readRunsFile(home, id) {
  try {
    const raw = JSON.parse(await readFile(learnedRunsPath(home, id), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

async function writeRunsFile(home, id, list) {
  const dir = learnedPaths(home, id).dir
  await mkdir(dir, { recursive: true })
  const trimmed = (Array.isArray(list) ? list : []).slice(0, MAX_LEARNED_RUNS)
  await writeFile(learnedRunsPath(home, id), `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8')
  return trimmed
}

/**
 * @param {string} home
 * @param {string} id
 * @param {{
 *   via?: string,
 *   ok?: boolean,
 *   summary?: string,
 *   understandingSnapshot?: string,
 * }} entry
 */
export async function appendLearnedRun(home, id, entry = {}) {
  const list = await readRunsFile(home, id)
  const row = {
    id: newRunId(),
    at: new Date().toISOString(),
    via: String(entry.via || 'unknown').slice(0, 40),
    ok: Boolean(entry.ok),
    summary: String(entry.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    understandingSnapshot: String(entry.understandingSnapshot || '').slice(0, 800),
    rating: null,
    comment: '',
    ratedAt: null,
    refined: false,
  }
  list.unshift(row)
  await writeRunsFile(home, id, list)
  return row
}

/**
 * @param {string} home
 * @param {string} id
 * @param {{ limit?: number }} [opts]
 */
export async function listLearnedRuns(home, id, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), MAX_LEARNED_RUNS) : 12
  const list = await readRunsFile(home, id)
  return list.slice(0, limit)
}

/**
 * @param {string} home
 * @param {string} id
 * @param {string} runId
 */
export async function getLearnedRun(home, id, runId) {
  const list = await readRunsFile(home, id)
  return list.find((r) => r?.id === runId) || null
}

/**
 * @param {string} home
 * @param {string} id
 * @param {string} runId
 * @param {object} patch
 */
export async function patchLearnedRun(home, id, runId, patch = {}) {
  const list = await readRunsFile(home, id)
  const i = list.findIndex((r) => r?.id === runId)
  if (i < 0) return { ok: false, reason: 'run-not-found' }
  list[i] = { ...list[i], ...patch }
  await writeRunsFile(home, id, list)
  return { ok: true, run: list[i] }
}

export function normalizeRating(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'good' || s === '好' || s === '赞') return 'good'
  if (s === 'ok' || s === '一般' || s === '还行' || s === 'mid') return 'ok'
  if (s === 'bad' || s === '差' || s === '不好' || s === '糟') return 'bad'
  return null
}
