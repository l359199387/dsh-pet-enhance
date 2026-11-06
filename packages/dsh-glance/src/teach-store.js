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
    playbook: join(dir, `${id}.playbook.json`),
    index: join(dir, 'index.json'),
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
        eventI: ev.i,
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
          eventI: ev.i,
          action: 'type',
          secretRef: ev.secretRef,
          window: ev.window?.title || null,
          reason: `教学步骤 #${ev.i} 输入敏感内容（仅本地）`,
          publicNote: '输入（本地敏感·已保存，不上模型）',
        })
      } else {
        steps.push({
          eventI: ev.i,
          action: 'type',
          text: ev.text || '',
          window: ev.window?.title || null,
          reason: `教学步骤 #${ev.i} 输入`,
        })
      }
    } else if (ev.kind === 'key') {
      steps.push({
        eventI: ev.i,
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
      const win = s.window ? ` 「${String(s.window).slice(0, 24)}」` : ''
      const img = s.hint?.imageX != null
        ? ` → 图内(${s.hint.imageX},${s.hint.imageY})`
        : ''
      return `${n}. ${s.action} 屏幕(${s.x},${s.y})${img}${win}`
    }
    if (s.action === 'type') {
      if (s.secretRef || s.publicNote?.includes('敏感')) {
        return `${n}. ${s.publicNote || '输入（敏感·仅本地）'}`
      }
      const t = String(s.text || '').slice(0, 40)
      return `${n}. 用户键入文字「${t}」`
    }
    if (s.action === 'key') return `${n}. 按键 ${s.keys}`
    return `${n}. ${s.action}`
  }).join('\n')
}

/** 仅这些按键允许本地脚本；其余按键走 glance。明文 type 另按 typed-text 记 script。 */
const SAFE_SCRIPT_KEYS = new Set([
  'enter', 'tab', 'esc', 'escape',
  'ctrl+s', 'ctrl+c', 'ctrl+v', 'ctrl+a', 'ctrl+z',
  'alt+f4', 'ctrl+enter',
])

/**
 * Host 侧零模型消化。
 * - 用户亲手键入的明文 → script（记成「文字」步骤，自动化可复打同一段字）
 * - 敏感 type → script + secretRef（不上模型）
 * - 点击坐标 → glance（界面易变，禁止盲点）
 * 教完仍不自动执行；只有用户说跑才动手。
 */
export function buildPlaybook(goal, steps, sessionId) {
  const items = (steps || []).map((s, i) => {
    if (s.action === 'key') {
      const keys = String(s.keys || '').toLowerCase()
      if (SAFE_SCRIPT_KEYS.has(keys)) {
        return {
          i,
          mode: 'script',
          action: 'key',
          keys: s.keys,
          window: s.window || null,
        }
      }
      return {
        i,
        mode: 'glance',
        action: 'key',
        keys: s.keys,
        window: s.window || null,
        hint: { keys: s.keys },
      }
    }
    if (s.action === 'type' && s.secretRef) {
      return {
        i,
        mode: 'script',
        action: 'type',
        secretRef: `${sessionId}/${s.secretRef}`,
        window: s.window || null,
        publicNote: '输入（本地敏感·已保存，不上模型）',
      }
    }
    if (s.action === 'type') {
      const text = String(s.text || '').slice(0, 500)
      // 主人自己打的字：记成文字步骤（如文件夹名 meirixinqing1）
      return {
        i,
        mode: 'script',
        action: 'type',
        text,
        window: s.window || null,
        kind: 'typed-text',
        publicNote: s.publicNote || `用户键入文字「${text.slice(0, 40)}」`,
      }
    }
    return {
      i,
      eventI: s.eventI != null ? s.eventI : i,
      mode: 'glance',
      action: s.action,
      button: s.button || 'left',
      window: s.window || null,
      hint: { x: s.x, y: s.y },
    }
  })
  const script = items.filter((x) => x.mode === 'script').length
  const glance = items.filter((x) => x.mode === 'glance').length
  return {
    v: 1,
    id: sessionId,
    goal: String(goal || '').slice(0, 200),
    createdAt: new Date().toISOString(),
    steps: items,
    stats: { total: items.length, script, glance },
  }
}

/**
 * 学习中必须问清的歧义（不耗模型 token）。
 * @returns {{ code: string, summary: string }[]}
 */
export function detectTeachAmbiguities(goal, steps) {
  const qs = []
  const g = String(goal || '').trim()
  if (!g || g === '完成刚才教的流程' || g.length < 2) {
    qs.push({
      code: 'goal',
      summary: '目标还不清楚。请确认：现在是要我学会并完成「刚才那套操作」吗？',
    })
  }
  if (!steps?.length) {
    qs.push({ code: 'empty', summary: '这轮没记到步骤，要重新教一遍吗？' })
  } else if (steps.length < 2) {
    qs.push({
      code: 'short',
      summary: `只记到 ${steps.length} 步，确定就按这个去做「${g.slice(0, 28)}」吗？`,
    })
  }
  const bareClicks = (steps || []).filter(
    (s) => (s.action === 'click' || s.action === 'double_click') && !s.window,
  )
  if (bareClicks.length > 0) {
    qs.push({
      code: 'window',
      summary: `有 ${bareClicks.length} 次点击没记到窗口名，界面变了可能点错。还继续吗？`,
    })
  }
  return qs
}

/** 给模型的极短证据行（仅 glance 步；脚本步不送）。 */
export function compactGlanceHints(playbook) {
  const steps = playbook?.steps || []
  return steps
    .filter((s) => s.mode === 'glance')
    .map((s) => {
      const win = s.window ? String(s.window).slice(0, 28) : '?'
      const h = s.hint || {}
      if (s.action === 'type' && h.typed != null) {
        return `${s.i + 1}.type@${win}~「${String(h.typed).slice(0, 20)}」`
      }
      if (s.action === 'key') return `${s.i + 1}.key@${win}~${h.keys || s.keys || ''}`
      return `${s.i + 1}.${s.action}@${win}~(${h.x},${h.y})`
    })
    .join(';')
}

export async function savePlaybook(home, playbook) {
  const id = playbook?.id
  if (!id) throw new Error('playbook.id required')
  const paths = sessionPaths(home, id)
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.playbook, `${JSON.stringify(playbook, null, 2)}\n`, 'utf8')
  await upsertPlaybookIndex(home, {
    id,
    goal: playbook.goal,
    at: playbook.createdAt || new Date().toISOString(),
    stats: playbook.stats || null,
  })
  return paths.playbook
}

export async function readPlaybook(home, id) {
  const paths = sessionPaths(home, id)
  try {
    return JSON.parse(await readFile(paths.playbook, 'utf8'))
  } catch {
    return null
  }
}

async function upsertPlaybookIndex(home, entry) {
  const paths = sessionPaths(home, entry.id)
  let list = []
  try {
    list = JSON.parse(await readFile(paths.index, 'utf8'))
    if (!Array.isArray(list)) list = []
  } catch { /* empty */ }
  list = list.filter((x) => x?.id !== entry.id)
  list.unshift({
    id: entry.id,
    goal: String(entry.goal || '').slice(0, 200),
    at: entry.at,
    stats: entry.stats || null,
  })
  list = list.slice(0, 50)
  await writeFile(paths.index, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
}

export async function listPlaybookIndex(home) {
  const paths = sessionPaths(home, '_')
  try {
    const list = JSON.parse(await readFile(paths.index, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 用用户话粗匹配最近 playbook（再次执行少 token）。
 * @param {string} home
 * @param {string} query
 */
export async function findPlaybookForQuery(home, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  const list = await listPlaybookIndex(home)
  if (!list.length) return null

  // 「刚才教的 / 再做一次」→ 最新一条
  if (/刚才教的|再做一次|照着做|按教学|上次教的|再来一遍/.test(q)) {
    return readPlaybook(home, list[0].id)
  }

  let best = null
  let bestScore = 0
  for (const row of list) {
    const goal = String(row.goal || '').toLowerCase()
    if (!goal) continue
    let score = 0
    if (q.includes(goal) || goal.includes(q)) score = Math.max(score, goal.length)
    for (const token of goal.split(/[\s，,。、]+/).filter((t) => t.length >= 2)) {
      if (q.includes(token)) score += token.length
    }
    if (score > bestScore) {
      bestScore = score
      best = row
    }
  }
  if (!best || bestScore < 2) return null
  return readPlaybook(home, best.id)
}
