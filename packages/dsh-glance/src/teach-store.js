/**
 * 教学会话落盘：全量本地 JSONL；敏感正文进 secrets，不上模型。
 *
 * @module src/teach-store.js
 */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeniedWindow, isPetChromeTitle } from './policy.js'

/**
 * 教学噪声键入：对宠说「教完了」的拼音/汉字，或 IME 选词残留下的孤立数字。
 * 这些不是业务正文，自动化不应复打。
 * @param {string | null | undefined} text
 * @param {{ prevText?: string | null }} [ctx]
 */
export function isTeachNoiseTypedText(text, ctx = {}) {
  const raw = String(text ?? '')
  const t = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return true
  if (/我教完了|我学完了|教完了|学完了|教好了|结束教学/.test(raw)) return true
  if (/^(wo)?(jie)?(jiao|xue)?wanle\d*$/i.test(t)) return true
  if (/^wojiaowanle\d*$/i.test(t) || /^wojiexuewanle\d*$/i.test(t)) return true
  // 上一步已是「教完了」拼音时，后面单独冒出来的选词数字 1–9
  const prev = String(ctx.prevText ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (/^\d$/.test(t) && prev && /wanle\d*$/i.test(prev)) return true
  return false
}

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

/** 教学认的鼠标点击 kind（任意键，不只左键） */
export function isTeachMouseClickKind(kind) {
  const k = String(kind || '').toLowerCase()
  return (
    k === 'click'
    || k === 'double_click'
    || k === 'right_click'
    || k === 'middle_click'
  )
}

/** 滑轮手势起止（中间每格不单独记） */
export function isTeachScrollBoundaryKind(kind) {
  const k = String(kind || '').toLowerCase()
  return k === 'scroll_start' || k === 'scroll_end'
}

/**
 * @param {unknown} button
 * @param {string} [kind]
 * @returns {'left'|'right'|'middle'|'x1'|'x2'}
 */
export function normalizeMouseButton(button, kind = '') {
  const b = String(button || '').toLowerCase()
  if (b === 'right' || b === 'r') return 'right'
  if (b === 'middle' || b === 'm' || b === 'wheel') return 'middle'
  if (b === 'x1' || b === 'back' || b === 'button4') return 'x1'
  if (b === 'x2' || b === 'forward' || b === 'button5') return 'x2'
  if (b === 'left' || b === 'l') return 'left'
  const k = String(kind || '').toLowerCase()
  if (k === 'right_click') return 'right'
  if (k === 'middle_click') return 'middle'
  return 'left'
}

/** 给人/模型看的键位名 */
export function formatMouseButtonLabel(button) {
  switch (normalizeMouseButton(button)) {
    case 'right': return '右键'
    case 'middle': return '中键'
    case 'x1': return '侧键1'
    case 'x2': return '侧键2'
    default: return '左键'
  }
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
  if (isTeachMouseClickKind(kind)) {
    const button = normalizeMouseButton(raw?.button, kind)
    return {
      ...base,
      kind: kind === 'right_click' || kind === 'middle_click' ? 'click' : kind,
      button,
      x: Number(raw?.x),
      y: Number(raw?.y),
    }
  }
  if (isTeachScrollBoundaryKind(kind)) {
    return {
      ...base,
      kind,
      x: Number(raw?.x),
      y: Number(raw?.y),
      delta: Number(raw?.delta) || 0,
      horizontal: Boolean(raw?.horizontal),
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
  /** @type {string | null} */
  let lastTyped = null
  for (const ev of events) {
    if (isTeachMouseClickKind(ev.kind)) {
      const button = normalizeMouseButton(ev.button, ev.kind)
      steps.push({
        eventI: ev.i,
        action: ev.kind === 'double_click' ? 'double_click' : 'click',
        x: ev.x,
        y: ev.y,
        button,
        window: ev.window?.title || null,
        reason: `教学步骤 #${ev.i} ${formatMouseButtonLabel(button)}${ev.window?.title ? ` @ ${ev.window.title}` : ''}`,
      })
    } else if (isTeachScrollBoundaryKind(ev.kind)) {
      const phase = ev.kind === 'scroll_start' ? '开始' : '结束'
      const axis = ev.horizontal ? '横向' : '纵向'
      steps.push({
        eventI: ev.i,
        action: 'scroll',
        phase: ev.kind === 'scroll_start' ? 'start' : 'end',
        x: ev.x,
        y: ev.y,
        delta: ev.delta || 0,
        horizontal: Boolean(ev.horizontal),
        window: ev.window?.title || null,
        reason: `教学步骤 #${ev.i} 滑轮${axis}滚动${phase}`,
      })
    } else if (ev.kind === 'type') {
      const winTitle = ev.window?.title || null
      if (isPetChromeTitle(winTitle)) {
        // 对桌宠窗口的键入（教完了等）不进计划
        continue
      }
      if (ev.sensitive || ev.secretRef) {
        steps.push({
          eventI: ev.i,
          action: 'type',
          secretRef: ev.secretRef,
          window: winTitle,
          reason: `教学步骤 #${ev.i} 输入敏感内容（仅本地）`,
          publicNote: '输入（本地敏感·已保存，不上模型）',
        })
        lastTyped = null
      } else {
        const text = String(ev.text || '')
        if (isTeachNoiseTypedText(text, { prevText: lastTyped })) {
          lastTyped = text
          continue
        }
        steps.push({
          eventI: ev.i,
          action: 'type',
          text,
          window: winTitle,
          reason: `教学步骤 #${ev.i} 输入`,
        })
        lastTyped = text
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
      const btn = formatMouseButtonLabel(s.button || s.hint?.button)
      const act = s.action === 'double_click' ? `${btn}双击` : `${btn}点击`
      const img = s.hint?.imageX != null
        ? ` → 图内(${s.hint.imageX},${s.hint.imageY})`
        : ''
      return `${n}. ${act} 屏幕(${s.x},${s.y})${img}${win}`
    }
    if (s.action === 'scroll') {
      const win = s.window ? ` 「${String(s.window).slice(0, 24)}」` : ''
      const phase = s.phase === 'start' ? '开始' : '结束'
      const axis = s.horizontal ? '横向' : '纵向'
      const img = s.hint?.imageX != null
        ? ` → 图内(${s.hint.imageX},${s.hint.imageY})`
        : ''
      return `${n}. 滑轮${axis}滚动${phase} δ=${s.delta || 0} 屏幕(${s.x},${s.y})${img}${win}`
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
      if (isPetChromeTitle(s.window) || isTeachNoiseTypedText(text)) {
        return null
      }
      // 主人自己打的字：记成文字步骤（自动化可复打同一段字）
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
    if (s.action === 'scroll') {
      return {
        i,
        eventI: s.eventI != null ? s.eventI : i,
        mode: 'glance',
        action: 'scroll',
        phase: s.phase === 'start' ? 'start' : 'end',
        delta: Number(s.delta) || 0,
        horizontal: Boolean(s.horizontal),
        window: s.window || null,
        hint: { x: s.x, y: s.y, delta: Number(s.delta) || 0 },
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
  }).filter(Boolean)
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
