/**
 * 教学会话落盘：全量本地 JSONL；敏感正文进 secrets，不上模型。
 *
 * @module src/teach-store.js
 */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeniedWindow } from './policy.js'

export function teachDir(home) {
  return join(home, 'teach')
}

export function sessionPaths(home, id) {
  const dir = teachDir(home)
  return {
    dir,
    events: join(dir, `${id}.jsonl`),
    secrets: join(dir, `${id}.secrets.json`),
    meta: join(dir, `${id}.meta.json`),
  }
}

export function newTeachSessionId() {
  const d = new Date()
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '-',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('')
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

/**
 * @param {object} raw
 * @param {number} index
 */
export function normalizeTeachEvent(raw, index) {
  const kind = String(raw?.kind || '').toLowerCase()
  const title = raw?.window?.title ? String(raw.window.title) : ''
  const sensitive = Boolean(raw?.sensitive) || isDeniedWindow(title)
  const base = {
    i: index,
    kind,
    at: raw?.at ?? Date.now() / 1000,
    window: title ? { title: title.slice(0, 120) } : null,
    sensitive,
  }
  if (kind === 'click' || kind === 'double_click' || kind === 'right_click') {
    return {
      ...base,
      kind: kind === 'right_click' ? 'click' : kind,
      button: raw?.button || (kind === 'right_click' ? 'right' : 'left'),
      x: Number(raw?.x),
      y: Number(raw?.y),
    }
  }
  if (kind === 'type') {
    return {
      ...base,
      text: sensitive ? undefined : String(raw?.text ?? '').slice(0, 2000),
      textLen: String(raw?.text ?? '').length,
      secretRef: sensitive ? `step:${index}` : undefined,
    }
  }
  if (kind === 'key') {
    return {
      ...base,
      keys: String(raw?.keys ?? '').slice(0, 64),
    }
  }
  return { ...base, raw: undefined }
}

/**
 * @param {string} home
 * @param {string} id
 * @param {{ goal?: string }} [init]
 */
export async function createTeachSession(home, id, init = {}) {
  const paths = sessionPaths(home, id)
  await mkdir(paths.dir, { recursive: true })
  const meta = {
    id,
    goal: String(init.goal || '').slice(0, 200),
    status: 'recording',
    startedAt: new Date().toISOString(),
    endedAt: null,
    stepCount: 0,
  }
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  await writeFile(paths.secrets, `${JSON.stringify({ id, secrets: {} }, null, 2)}\n`, 'utf8')
  await writeFile(paths.events, '', 'utf8')
  return meta
}

/**
 * @param {string} home
 * @param {string} id
 * @param {object} rawEvent
 * @param {number} index
 */
export async function appendTeachEvent(home, id, rawEvent, index) {
  const paths = sessionPaths(home, id)
  const text = rawEvent?.kind === 'type' ? String(rawEvent.text ?? '') : ''
  const norm = normalizeTeachEvent(rawEvent, index)
  if (norm.sensitive && rawEvent?.kind === 'type' && text) {
    const secrets = JSON.parse(await readFile(paths.secrets, 'utf8'))
    secrets.secrets[norm.secretRef] = text
    await writeFile(paths.secrets, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8')
  }
  await appendFile(paths.events, `${JSON.stringify(norm)}\n`, 'utf8')
  return norm
}

export async function readTeachEvents(home, id) {
  const paths = sessionPaths(home, id)
  try {
    const raw = await readFile(paths.events, 'utf8')
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

export async function readTeachSecrets(home, id) {
  const paths = sessionPaths(home, id)
  try {
    const data = JSON.parse(await readFile(paths.secrets, 'utf8'))
    return data?.secrets && typeof data.secrets === 'object' ? data.secrets : {}
  } catch {
    return {}
  }
}

export async function updateTeachMeta(home, id, patch) {
  const paths = sessionPaths(home, id)
  let meta = {}
  try {
    meta = JSON.parse(await readFile(paths.meta, 'utf8'))
  } catch { /* new */ }
  const next = { ...meta, ...patch, id }
  await writeFile(paths.meta, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 给模型看的步骤摘要：敏感 type 只写「输入（本地敏感·已保存）」.
 * @param {object[]} events
 */
export function buildPublicPlan(events) {
  const steps = []
  for (const ev of events) {
    if (ev.kind === 'click' || ev.kind === 'double_click') {
      steps.push({
        action: ev.kind === 'double_click' ? 'double_click' : 'click',
        x: ev.x,
        y: ev.y,
        button: ev.button || 'left',
        window: ev.window?.title || null,
        reason: `教学步骤 #${ev.i}${ev.window?.title ? ` @ ${ev.window.title}` : ''}`,
      })
    } else if (ev.kind === 'type') {
      if (ev.sensitive || ev.secretRef) {
        steps.push({
          action: 'type',
          secretRef: ev.secretRef,
          window: ev.window?.title || null,
          reason: `教学步骤 #${ev.i} 输入敏感内容（仅本地）`,
          publicNote: '输入（本地敏感·已保存，不上模型）',
        })
      } else {
        steps.push({
          action: 'type',
          text: ev.text || '',
          window: ev.window?.title || null,
          reason: `教学步骤 #${ev.i} 输入`,
        })
      }
    } else if (ev.kind === 'key') {
      steps.push({
        action: 'key',
        keys: ev.keys,
        window: ev.window?.title || null,
        reason: `教学步骤 #${ev.i} 按键 ${ev.keys}`,
      })
    }
  }
  return steps
}

/**
 * 给用户听的复述（无秘密正文）。
 */
export function narratePlan(steps) {
  if (!steps.length) return '我还没记到有效步骤。'
  return steps.map((s, i) => {
    const n = i + 1
    if (s.action === 'click' || s.action === 'double_click') {
      return `${n}. ${s.action} (${s.x},${s.y})${s.window ? ` 「${String(s.window).slice(0, 24)}」` : ''}`
    }
    if (s.action === 'type') {
      return `${n}. ${s.publicNote || `输入「${String(s.text || '').slice(0, 24)}」`}`
    }
    if (s.action === 'key') return `${n}. 按键 ${s.keys}`
    return `${n}. ${s.action}`
  }).join('\n')
}
