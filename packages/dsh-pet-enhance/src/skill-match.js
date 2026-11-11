/**
 * 扫 ~/.dsh/skills 下各技能的 SKILL.md，按 goal/description/aliases 匹配「再做一次」。
 * 旧 learned/index 仅作 miss 时只读回落。
 *
 * @module src/skill-match.js
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isRunAutomationIntent } from './intent.js'
import {
  findAutomationForQuery,
  goalMatchTokens,
  scoreGoalAgainstQuery,
} from './learned-automation.js'
import { skillsRoot } from './teach-skill.js'

/**
 * 极简 YAML frontmatter 解析（只取本插件写入的字段）。
 * @param {string} raw
 */
export function parseSkillFrontmatter(raw) {
  const text = String(raw || '')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const fm = m[1]
  const body = m[2] || ''
  const meta = {}
  const lines = fm.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!kv) {
      i += 1
      continue
    }
    const key = kv[1]
    let val = kv[2].trim()
    if (key === 'aliases' && val === '') {
      const arr = []
      i += 1
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        arr.push(unquote(lines[i].replace(/^\s+-\s+/, '').trim()))
        i += 1
      }
      meta.aliases = arr
      continue
    }
    if (key === 'metadata') {
      i += 1
      continue
    }
    meta[key] = unquote(val)
    i += 1
  }
  return { meta, body }
}

function unquote(s) {
  const t = String(s ?? '').trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1).replace(/"/g, '\\"')}"` : t)
    } catch {
      return t.slice(1, -1)
    }
  }
  if (t === 'null') return null
  return t
}

function section(body, title) {
  const re = new RegExp(`##\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i')
  const m = String(body || '').match(re)
  return m ? m[1].trim() : ''
}

function parseScriptsFromBody(body) {
  const block = section(body, '脚本能力') || section(body, '脚本能力（按块，用到哪个执行哪个）')
  if (!block) return []
  const out = []
  for (const line of block.split(/\n/)) {
    const m = line.match(/^- `([^`]+)` → `([^`]+)`：(.+?)（/)
    if (!m) continue
    out.push({
      id: m[1],
      path: m[2],
      purpose: m[3].trim(),
      status: /ready/i.test(line) ? 'ready' : 'ready',
    })
  }
  return out
}

/**
 * @param {string} [root]
 * @returns {Promise<object[]>}
 */
export async function listTeachSkills(root = skillsRoot()) {
  let names = []
  try {
    const ents = await readdir(root, { withFileTypes: true })
    names = ents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    let raw = ''
    try {
      raw = await readFile(join(root, name, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseSkillFrontmatter(raw)
    const status = meta.status || 'verified'
    if (status && status !== 'verified') continue
    const goal = String(meta.goal || '').trim()
      || String(meta.description || '').split(/[。.（(]/)[0] || name
    const summary = section(body, '理解摘要')
    const fastPlan = section(body, '快捷路径')
    const constraintsRaw = section(body, '约束')
    const constraints = constraintsRaw
      ? constraintsRaw.split(/\n/).map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
      : []
    let mtime = 0
    try {
      mtime = Number((await stat(join(root, name, 'SKILL.md'))).mtimeMs) || 0
    } catch { /* ignore */ }
    const scripts = parseScriptsFromBody(body)
    out.push({
      name: meta.name || name,
      goal: String(goal).trim(),
      description: String(meta.description || ''),
      aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
      status,
      source: meta.source || null,
      verifiedAt: meta.verifiedAt || null,
      mtime,
      summary,
      fastPlan,
      constraints,
      scripts,
      skillName: meta.name || name,
      body,
      legacy: false,
    })
  }
  out.sort((a, b) => {
    const ta = Date.parse(a.verifiedAt || '') || a.mtime
    const tb = Date.parse(b.verifiedAt || '') || b.mtime
    return tb - ta
  })
  return out
}

export async function listSkillGoals(root = skillsRoot()) {
  const list = await listTeachSkills(root)
  return list.map((s) => s.goal).filter(Boolean).slice(0, 12)
}

function scoreSkillAgainstQuery(skill, q) {
  let score = scoreGoalAgainstQuery(skill.goal, q)
  score = Math.max(score, scoreGoalAgainstQuery(skill.description, q))
  for (const a of skill.aliases || []) {
    score = Math.max(score, scoreGoalAgainstQuery(a, q))
    if (q.includes(String(a).toLowerCase())) score += Math.min(String(a).length, 8)
  }
  for (const token of goalMatchTokens(skill.goal)) {
    if (q.includes(token)) score += Math.min(token.length, 8)
  }
  return score
}

/**
 * @param {string} query
 * @param {{
 *   root?: string,
 *   lastSkillName?: string | null,
 *   home?: string,
 *   allowLegacyLearned?: boolean,
 * }} [opts]
 */
export async function findSkillForQuery(query, opts = {}) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  const root = opts.root || skillsRoot()
  const list = await listTeachSkills(root)

  let best = null
  let bestScore = 0
  for (const skill of list) {
    const score = scoreSkillAgainstQuery(skill, q)
    if (score > bestScore) {
      bestScore = score
      best = skill
    }
  }
  if (best && bestScore >= 2) return best

  if (isRunAutomationIntent(query)) {
    if (opts.lastSkillName) {
      const hit = list.find((s) => s.name === opts.lastSkillName || s.skillName === opts.lastSkillName)
      if (hit) return hit
    }
    if (list[0]) return list[0]
  }

  if (opts.allowLegacyLearned !== false && opts.home) {
    const playbook = await findAutomationForQuery(opts.home, query)
    if (playbook) {
      return {
        name: playbook.id,
        skillName: null,
        goal: playbook.goal,
        summary: playbook.strategy?.summary || playbook.understanding?.summary || '',
        fastPlan: playbook.strategy?.fastPlan || playbook.understanding?.fastPlan || '',
        scripts: [],
        legacy: true,
        playbook,
        id: playbook.id,
      }
    }
  }
  return null
}

/**
 * 合成 runReadyCoachScripts 可用的 meta。
 */
export function skillToRunMeta(skill) {
  if (!skill) return null
  if (skill.legacy) {
    return {
      legacy: true,
      id: skill.id || skill.playbook?.id,
      playbook: skill.playbook,
      goal: skill.goal,
      understanding: {
        summary: skill.summary,
        fastPlan: skill.fastPlan,
      },
      capability: { skillName: null, scripts: [] },
    }
  }
  return {
    legacy: false,
    skillName: skill.skillName || skill.name,
    goal: skill.goal,
    understanding: {
      summary: skill.summary || '',
      fastPlan: skill.fastPlan || '',
    },
    capability: {
      skillName: skill.skillName || skill.name,
      scripts: Array.isArray(skill.scripts) ? skill.scripts : [],
    },
    strategy: {
      summary: skill.summary || '',
      fastPlan: skill.fastPlan || '',
    },
  }
}
