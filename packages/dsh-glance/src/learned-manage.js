/**
 * 「我学会的」：列表 / 编辑 / 删除（联动本地目录、skill、Harness schedule）。
 *
 * @module src/learned-manage.js
 */

import { rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  automationPaths,
  learnedPaths,
  learnedRoot,
  listLearnedIndex,
  readAutomationPlaybook,
  readAutomationTask,
  readLearned,
} from './learned-automation.js'
import { skillSlugFromId, writeGlanceSkillFile, buildHarnessAutomationPrompt } from './harness-schedule.js'
import { serviceOf } from './host-ctx.js'
import { wakeSession, waitAssistantReply } from './wake-session.js'
import { buildOwnerNotesMergePrompt, parseMergedSummary } from './learned-merge.js'

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

async function readIndex(path) {
  try {
    const list = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function writeIndex(path, list) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(list.slice(0, 80), null, 2)}\n`, 'utf8')
}

async function removeFromIndex(path, id) {
  const list = (await readIndex(path)).filter((x) => x?.id !== id)
  await writeIndex(path, list)
}

function skillDirFor(id) {
  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(root, 'skills', skillSlugFromId(id))
}

/**
 * @param {string} home
 * @param {string} id
 */
export async function getLearnedDetail(home, id) {
  const learn = await readLearned(home, id)
  if (!learn) return null
  const task = await readAutomationTask(home, id)
  const playbook = await readAutomationPlaybook(home, id)
  const summary = String(learn.understanding?.summary || '')
  return {
    id: learn.id,
    goal: String(learn.goal || task?.goal || playbook?.goal || ''),
    ownerNotes: String(learn.ownerNotes || task?.ownerNotes || ''),
    /** 小蓝鲸学习理解（只读展示；保存主人想法后由模型归纳更新） */
    understanding: summary,
    summary,
    fastPlan: String(learn.understanding?.fastPlan || ''),
    scheduled: Boolean(learn.scheduled || task?.scheduled),
    scheduleId: learn.scheduleId || task?.scheduleId || null,
    scheduleSessionId: learn.scheduleSessionId || task?.scheduleSessionId || null,
    timingLabel: learn.timingLabel || task?.timingLabel || null,
    skillName: learn.skillName || task?.skillName || skillSlugFromId(id),
    createdAt: learn.createdAt || task?.createdAt || null,
    updatedAt: learn.updatedAt || task?.updatedAt || learn.createdAt || null,
    stats: learn.understanding?.stats || task?.stats || playbook?.stats || null,
  }
}

/**
 * @param {string} home
 */
export async function listLearnedDetails(home) {
  const index = await listLearnedIndex(home)
  const out = []
  for (const row of index) {
    const detail = await getLearnedDetail(home, row.id)
    if (detail) out.push(detail)
  }
  // index 可能缺漏目录：补扫
  if (!out.length) {
    try {
      const { readdir } = await import('node:fs/promises')
      const dirs = await readdir(learnedRoot(home), { withFileTypes: true })
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const detail = await getLearnedDetail(home, d.name)
        if (detail) out.push(detail)
      }
    } catch { /* empty */ }
  }
  return out
}

/**
 * 教完后把 Harness 定时信息写回 LEARN/task。
 */
export async function patchLearnedScheduleMeta(home, id, meta = {}) {
  const learn = await readLearned(home, id)
  const task = await readAutomationTask(home, id)
  if (!learn && !task) return { ok: false, reason: 'missing' }
  const now = new Date().toISOString()
  const patch = {
    scheduleId: meta.scheduleId ?? null,
    scheduleSessionId: meta.scheduleSessionId ?? null,
    scheduled: Boolean(meta.scheduled),
    timingLabel: meta.timingLabel ?? null,
    skillName: meta.skillName ?? null,
    updatedAt: now,
  }
  if (learn) {
    Object.assign(learn, patch)
    await writeFile(learnedPaths(home, id).learn, `${JSON.stringify(learn, null, 2)}\n`, 'utf8')
  }
  if (task) {
    Object.assign(task, patch)
    await writeFile(automationPaths(home, id).task, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  }
  return { ok: true }
}

/**
 * @param {string} home
 * @param {string} id
 * @param {{ goal?: string, ownerNotes?: string }} patch
 * @param {{
 *   ctx?: object,
 *   log?: Function,
 *   preferredSessionId?: string | null,
 *   wake?: Function,
 *   waitReply?: Function,
 *   mergeNotes?: boolean,
 * }} [opts]
 */
export async function updateLearnedPair(home, id, patch = {}, opts = {}) {
  const log = opts.log ?? (() => {})
  const learn = await readLearned(home, id)
  const task = await readAutomationTask(home, id)
  const playbook = await readAutomationPlaybook(home, id)
  if (!learn || !task) {
    return { ok: false, reason: 'not-found' }
  }

  const prevNotes = String(learn.ownerNotes || '')
  let now = new Date().toISOString()
  if (patch.goal != null) {
    const goal = String(patch.goal).trim().slice(0, 200)
    if (!goal) return { ok: false, reason: 'empty-goal' }
    learn.goal = goal
    task.goal = goal
    if (playbook) playbook.goal = goal
  }
  let notesChanged = false
  if (patch.ownerNotes != null) {
    const notes = String(patch.ownerNotes).slice(0, 4000)
    notesChanged = notes !== prevNotes
    learn.ownerNotes = notes
    task.ownerNotes = notes
  }
  learn.updatedAt = now
  task.updatedAt = now

  const lp = learnedPaths(home, id)
  const ap = automationPaths(home, id)
  await writeFile(lp.learn, `${JSON.stringify(learn, null, 2)}\n`, 'utf8')
  await writeFile(ap.task, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  if (playbook) {
    await writeFile(ap.playbook, `${JSON.stringify(playbook, null, 2)}\n`, 'utf8')
  }

  for (const indexPath of [lp.index, ap.index]) {
    const list = await readIndex(indexPath)
    const next = list.map((row) => (
      row?.id === id ? { ...row, goal: learn.goal, at: now } : row
    ))
    await writeIndex(indexPath, next)
  }

  /** @type {{ merged?: boolean, reason?: string }} */
  const mergeInfo = { merged: false }

  // 主人想法有变且非空 → 叫醒模型归纳进学习理解
  const shouldMerge = opts.mergeNotes !== false
    && notesChanged
    && String(learn.ownerNotes || '').trim()
    && opts.ctx

  if (shouldMerge) {
    const wake = opts.wake ?? wakeSession
    const waitReply = opts.waitReply ?? waitAssistantReply
    const prompt = buildOwnerNotesMergePrompt({
      goal: learn.goal,
      summary: learn.understanding?.summary || '',
      ownerNotes: learn.ownerNotes,
    })
    try {
      const woken = await wake(opts.ctx, {
        text: prompt,
        preferredId: opts.preferredSessionId || null,
        log,
      })
      if (!woken.ok) {
        mergeInfo.reason = woken.reason || 'wake-failed'
        log(`归纳学习理解未叫醒：${mergeInfo.reason}`)
      } else {
        const reply = await waitReply(opts.ctx, woken.sessionId, { timeoutMs: 90_000 })
        const merged = parseMergedSummary(reply.ok ? reply.text : '')
        if (merged) {
          learn.understanding = {
            ...(learn.understanding || {}),
            summary: merged,
          }
          now = new Date().toISOString()
          learn.updatedAt = now
          task.updatedAt = now
          await writeFile(lp.learn, `${JSON.stringify(learn, null, 2)}\n`, 'utf8')
          await writeFile(ap.task, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
          if (playbook) {
            playbook.understanding = playbook.understanding || {}
            playbook.understanding.summary = merged
            if (playbook.strategy) playbook.strategy.summary = merged
            await writeFile(ap.playbook, `${JSON.stringify(playbook, null, 2)}\n`, 'utf8')
          }
          mergeInfo.merged = true
        } else {
          mergeInfo.reason = reply.reason || 'empty-summary'
          log(`归纳学习理解无 SUMMARY：${mergeInfo.reason}`)
        }
      }
    } catch (e) {
      mergeInfo.reason = String(e?.message ?? e).slice(0, 160)
      log(`归纳学习理解失败：${mergeInfo.reason}`)
    }
  }

  try {
    await writeGlanceSkillFile({
      goal: learn.goal,
      learnedId: id,
      automationId: id,
      summary: learn.understanding?.summary || '',
    })
  } catch (e) {
    log(`更新 skill 失败：${e?.message ?? e}`)
  }

  const scheduleId = learn.scheduleId || task.scheduleId
  const sessionId = learn.scheduleSessionId || task.scheduleSessionId
  if (scheduleId && opts.ctx) {
    const schedule = serviceOf(opts.ctx, 'schedule')
    if (schedule?.update) {
      const title = clip(learn.goal.startsWith('小蓝鲸') ? learn.goal : `小蓝鲸｜${learn.goal}`, 120)
      const skillName = learn.skillName || skillSlugFromId(id)
      const prompt = buildHarnessAutomationPrompt({
        goal: learn.goal,
        learnedId: id,
        skillName,
        ownerNotes: learn.ownerNotes,
      })
      try {
        await schedule.update({
          id: scheduleId,
          sessionId: sessionId || undefined,
          title,
          prompt,
        })
      } catch (e) {
        log(`schedule.update 失败（本地已改）：${e?.message ?? e}`)
      }
    }
  }

  return {
    ok: true,
    merged: mergeInfo.merged,
    mergeReason: mergeInfo.reason || null,
    detail: await getLearnedDetail(home, id),
  }
}

/**
 * @param {string} home
 * @param {string} id
 * @param {{ ctx?: object, log?: Function }} [opts]
 */
export async function deleteLearnedPair(home, id, opts = {}) {
  const log = opts.log ?? (() => {})
  const learn = await readLearned(home, id)
  const task = await readAutomationTask(home, id)
  if (!learn && !task) {
    return { ok: false, reason: 'not-found' }
  }

  const scheduleId = learn?.scheduleId || task?.scheduleId
  const sessionId = learn?.scheduleSessionId || task?.scheduleSessionId
  let scheduleDeleted = false
  if (scheduleId && opts.ctx) {
    const schedule = serviceOf(opts.ctx, 'schedule')
    if (schedule?.delete) {
      try {
        await schedule.delete({ id: scheduleId, sessionId: sessionId || undefined })
        scheduleDeleted = true
      } catch (e) {
        // 再试旧签名 delete(sessionId, id)
        try {
          if (sessionId) {
            await schedule.delete(sessionId, scheduleId)
            scheduleDeleted = true
          } else {
            throw e
          }
        } catch (e2) {
          log(`schedule.delete 失败：${e2?.message ?? e2}`)
        }
      }
    }
  }

  const lp = learnedPaths(home, id)
  const ap = automationPaths(home, id)
  await removeFromIndex(lp.index, id)
  await removeFromIndex(ap.index, id)

  for (const dir of [lp.dir, ap.dir, skillDirFor(id)]) {
    if (!existsSync(dir)) continue
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (e) {
      log(`删除目录失败 ${dir}：${e?.message ?? e}`)
    }
  }

  return {
    ok: true,
    id,
    scheduleDeleted,
    scheduleId: scheduleId || null,
  }
}

// re-export for tests that might look here
export { skillSlugFromId }
