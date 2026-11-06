/**
 * 学会的东西（learned）与自动化任务（automation）一一对应，同 id 本地落盘。
 *
 * 流程约定：教完 → 理解 → 问清 → 再创建这一对；先建再执行。
 *
 * ~/.dsh/glance/learned/<id>/LEARN.json + evidence.json
 * ~/.dsh/glance/automations/<id>/task.json + playbook.json
 *
 * @module src/learned-automation.js
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function learnedRoot(home) {
  return join(home, 'learned')
}

export function automationRoot(home) {
  return join(home, 'automations')
}

export function learnedPaths(home, id) {
  const dir = join(learnedRoot(home), id)
  return {
    dir,
    learn: join(dir, 'LEARN.json'),
    evidence: join(dir, 'evidence.json'),
    index: join(learnedRoot(home), 'index.json'),
  }
}

export function automationPaths(home, id) {
  const dir = join(automationRoot(home), id)
  return {
    dir,
    task: join(dir, 'task.json'),
    playbook: join(dir, 'playbook.json'),
    index: join(automationRoot(home), 'index.json'),
  }
}

/**
 * 问清之后创建 1:1 对。id 建议用教学会话 id。
 * @param {string} home
 * @param {{
 *   id: string,
 *   goal: string,
 *   teachSessionId: string,
 *   understanding: { summary: string, stats?: object, clarified?: string[] },
 *   evidence: object[],
 *   playbook: object,
 *   frames?: { count?: number, files?: string[], forLearningOnly?: boolean },
 * }} spec
 */
export async function createLearnedAutomationPair(home, spec) {
  const id = String(spec.id || '').trim()
  if (!id) throw new Error('id required')
  const goal = String(spec.goal || '').slice(0, 200)
  const now = new Date().toISOString()

  const learnPaths = learnedPaths(home, id)
  const autoPaths = automationPaths(home, id)
  await mkdir(learnPaths.dir, { recursive: true })
  await mkdir(autoPaths.dir, { recursive: true })

  const learn = {
    v: 1,
    id,
    kind: 'learned',
    goal,
    teachSessionId: spec.teachSessionId || id,
    automationId: id,
    understanding: {
      summary: String(spec.understanding?.summary || '').slice(0, 800),
      stats: spec.understanding?.stats || null,
      clarified: Array.isArray(spec.understanding?.clarified)
        ? spec.understanding.clarified
        : [],
    },
    frames: {
      count: Number(spec.frames?.count) || 0,
      files: Array.isArray(spec.frames?.files) ? spec.frames.files : [],
      forLearningOnly: true,
      note: '仅辅助学会；自动化执行不要加载',
    },
    createdAt: now,
  }

  const task = {
    v: 1,
    id,
    kind: 'automation',
    goal,
    learnedId: id,
    teachSessionId: spec.teachSessionId || id,
    status: 'ready',
    stats: spec.playbook?.stats || null,
    createdAt: now,
  }

  const playbook = {
    ...spec.playbook,
    id,
    goal,
    learnedId: id,
    automationId: id,
  }

  await writeFile(learnPaths.learn, `${JSON.stringify(learn, null, 2)}\n`, 'utf8')
  await writeFile(
    learnPaths.evidence,
    `${JSON.stringify({ id, goal, steps: spec.evidence || [] }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(autoPaths.task, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  await writeFile(autoPaths.playbook, `${JSON.stringify(playbook, null, 2)}\n`, 'utf8')

  await upsertIndex(learnPaths.index, {
    id,
    goal,
    at: now,
    automationId: id,
    stats: playbook.stats || null,
  })
  await upsertIndex(autoPaths.index, {
    id,
    goal,
    at: now,
    learnedId: id,
    stats: playbook.stats || null,
  })

  return { learn, task, playbook }
}

async function upsertIndex(indexPath, entry) {
  await mkdir(join(indexPath, '..'), { recursive: true })
  let list = []
  try {
    list = JSON.parse(await readFile(indexPath, 'utf8'))
    if (!Array.isArray(list)) list = []
  } catch { /* empty */ }
  list = list.filter((x) => x?.id !== entry.id)
  list.unshift({
    id: entry.id,
    goal: String(entry.goal || '').slice(0, 200),
    at: entry.at,
    automationId: entry.automationId || entry.id,
    learnedId: entry.learnedId || entry.id,
    stats: entry.stats || null,
  })
  list = list.slice(0, 80)
  await writeFile(indexPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
}

export async function listLearnedIndex(home) {
  try {
    const list = JSON.parse(await readFile(join(learnedRoot(home), 'index.json'), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function listAutomationIndex(home) {
  try {
    const list = JSON.parse(await readFile(join(automationRoot(home), 'index.json'), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function readLearned(home, id) {
  try {
    return JSON.parse(await readFile(learnedPaths(home, id).learn, 'utf8'))
  } catch {
    return null
  }
}

export async function readAutomationTask(home, id) {
  try {
    return JSON.parse(await readFile(automationPaths(home, id).task, 'utf8'))
  } catch {
    return null
  }
}

export async function readAutomationPlaybook(home, id) {
  try {
    return JSON.parse(await readFile(automationPaths(home, id).playbook, 'utf8'))
  } catch {
    return null
  }
}

/** 校验 1:1：两边都在且互相指向。 */
export async function assertLearnedAutomationPair(home, id) {
  const learn = await readLearned(home, id)
  const task = await readAutomationTask(home, id)
  const playbook = await readAutomationPlaybook(home, id)
  if (!learn || !task || !playbook) {
    return { ok: false, reason: 'missing', learn, task, playbook }
  }
  if (learn.automationId !== id || task.learnedId !== id) {
    return { ok: false, reason: 'link-mismatch', learn, task, playbook }
  }
  return { ok: true, learn, task, playbook }
}

/**
 * 按用户话匹配已学会条目（再取同 id 自动化）。
 */
export async function findLearnedForQuery(home, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  const list = await listLearnedIndex(home)
  if (!list.length) return null

  async function usable(id) {
    const learn = await readLearned(home, id)
    if (!learn) return null
    if (learn.status === 'deprecated-reteach' || learn.deprecatedReason) return null
    return learn
  }

  if (/刚才教的|再做一次|照着做|按教学|上次教的|再来一遍|跑自动化|执行一下|运行一下/.test(q)) {
    // 若话里还带了目标关键词，优先精确匹配；否则取最新可用
    let hinted = null
    let hintedScore = 0
    for (const row of list) {
      const goal = String(row.goal || '').toLowerCase()
      if (!goal) continue
      let score = 0
      if (q.includes(goal)) score = goal.length * 2
      for (const token of goal.split(/[\s，,。、]+/).filter((t) => t.length >= 2)) {
        if (q.includes(token)) score += token.length
      }
      if (score > hintedScore) {
        hintedScore = score
        hinted = row
      }
    }
    if (hinted && hintedScore >= 2) {
      const learn = await usable(hinted.id)
      if (learn) return learn
    }
    for (const row of list) {
      const learn = await usable(row.id)
      if (learn) return learn
    }
    return null
  }

  let best = null
  let bestScore = 0
  for (const row of list) {
    const goal = String(row.goal || '').toLowerCase()
    if (!goal) continue
    let score = 0
    if (q.includes(goal) || goal.includes(q)) score = Math.max(score, goal.length)
    // 「去记录一下每日心情」对「记录每日心情」：去掉「一下/一遍」再比
    const qCompact = q.replace(/一下|一遍|一回|请|帮我|去|执行|运行|跑/g, '')
    const gCompact = goal.replace(/\s+/g, '')
    if (qCompact.includes(gCompact) || gCompact.includes(qCompact)) {
      score = Math.max(score, gCompact.length)
    }
    for (const token of goal.split(/[\s，,。、]+/).filter((t) => t.length >= 2)) {
      if (q.includes(token)) score += token.length
    }
    if (score > bestScore) {
      bestScore = score
      best = row
    }
  }
  if (!best || bestScore < 2) return null
  return usable(best.id)
}

export async function findAutomationForQuery(home, query) {
  const learned = await findLearnedForQuery(home, query)
  if (!learned?.id) return null
  const pair = await assertLearnedAutomationPair(home, learned.id)
  if (!pair.ok) return null
  return pair.playbook
}
