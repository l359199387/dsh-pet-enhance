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
import {
  buildOwnerNotesMergePrompt,
  buildRunFeedbackMergePrompt,
  constraintsFromNotes,
  localMergeOwnerNotes,
  localMergeRunFeedback,
  parseMergedSummary,
} from './learned-merge.js'
import {
  getLearnedRun,
  listLearnedRuns,
  normalizeRating,
  patchLearnedRun,
  RATING_LABELS,
} from './learned-runs.js'

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
  const runs = await listLearnedRuns(home, id, { limit: 12 })
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
    runs,
    runCount: runs.length,
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

  let now = new Date().toISOString()
  if (patch.goal != null) {
    const goal = String(patch.goal).trim().slice(0, 200)
    if (!goal) return { ok: false, reason: 'empty-goal' }
    learn.goal = goal
    task.goal = goal
    if (playbook) playbook.goal = goal
  }
  if (patch.ownerNotes != null) {
    const notes = String(patch.ownerNotes).slice(0, 4000)
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

  /** @type {{ merged?: boolean, reason?: string, via?: string }} */
  const mergeInfo = { merged: false }

  // 补充非空就尝试归纳（可重复保存重试；不再要求 notes 文本有变更）
  const notesText = String(learn.ownerNotes || '').trim()
  const shouldMerge = opts.mergeNotes !== false && Boolean(notesText)

  if (shouldMerge) {
    const wake = opts.wake ?? wakeSession
    const waitReply = opts.waitReply ?? waitAssistantReply
    const prompt = buildOwnerNotesMergePrompt({
      goal: learn.goal,
      summary: learn.understanding?.summary || '',
      ownerNotes: learn.ownerNotes,
    })
    let mergedSummary = ''
    let via = 'llm'
    try {
      if (opts.ctx) {
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
          mergedSummary = parseMergedSummary(reply.ok ? reply.text : '')
          if (!mergedSummary) {
            mergeInfo.reason = reply.reason || 'empty-summary'
            log(`归纳学习理解无 SUMMARY：${mergeInfo.reason}`)
          }
        }
      } else {
        mergeInfo.reason = 'no-ctx'
      }
    } catch (e) {
      mergeInfo.reason = String(e?.message ?? e).slice(0, 160)
      log(`归纳学习理解失败：${mergeInfo.reason}`)
    }

    if (!mergedSummary) {
      mergedSummary = localMergeOwnerNotes(learn.understanding?.summary || '', notesText)
      via = 'local'
      if (!mergeInfo.reason) mergeInfo.reason = 'local-fallback'
      log(`归纳学习理解回落本地合并（${mergeInfo.reason}）`)
    }

    if (mergedSummary) {
      const constraints = constraintsFromNotes(
        notesText,
        learn.understanding?.constraints || [],
      )
      learn.understanding = {
        ...(learn.understanding || {}),
        summary: mergedSummary,
        constraints,
      }
      // 补充只为帮助理解：归纳完成后清空，避免重复展示
      learn.ownerNotes = ''
      task.ownerNotes = ''
      now = new Date().toISOString()
      learn.updatedAt = now
      task.updatedAt = now
      await writeFile(lp.learn, `${JSON.stringify(learn, null, 2)}\n`, 'utf8')
      await writeFile(ap.task, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
      if (playbook) {
        playbook.understanding = playbook.understanding || {}
        playbook.understanding.summary = mergedSummary
        playbook.understanding.constraints = constraints
        if (playbook.strategy) playbook.strategy.summary = mergedSummary
        await writeFile(ap.playbook, `${JSON.stringify(playbook, null, 2)}\n`, 'utf8')
      }
      mergeInfo.merged = true
      mergeInfo.via = via
      if (via === 'llm') mergeInfo.reason = null
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
    mergeVia: mergeInfo.via || null,
    detail: await getLearnedDetail(home, id),
  }
}

/**
 * 对某次执行记录评价，并叫醒模型改正学习理解。
 * @param {string} home
 * @param {string} id
 * @param {string} runId
 * @param {{ rating: string, comment?: string }} body
 * @param {{
 *   ctx?: object,
 *   log?: Function,
 *   preferredSessionId?: string | null,
 *   wake?: Function,
 *   waitReply?: Function,
 * }} [opts]
 */
export async function rateLearnedRun(home, id, runId, body = {}, opts = {}) {
  const log = opts.log ?? (() => {})
  const rating = normalizeRating(body.rating)
  if (!rating) return { ok: false, reason: 'bad-rating' }
  const comment = String(body.comment || '').trim().slice(0, 400)

  const learn = await readLearned(home, id)
  if (!learn) return { ok: false, reason: 'not-found' }
  const run = await getLearnedRun(home, id, runId)
  if (!run) return { ok: false, reason: 'run-not-found' }

  const ratingLabel = RATING_LABELS[rating] || rating
  let merged = false
  let mergeReason = null
  let mergeVia = null
  let newSummary = ''

  const wake = opts.wake ?? wakeSession
  const waitReply = opts.waitReply ?? waitAssistantReply
  const prompt = buildRunFeedbackMergePrompt({
    goal: learn.goal,
    summary: learn.understanding?.summary || '',
    runSummary: run.summary,
    via: run.via,
    ok: run.ok,
    rating: ratingLabel,
    comment,
  })
  try {
    if (opts.ctx) {
      const woken = await wake(opts.ctx, {
        text: prompt,
        preferredId: opts.preferredSessionId || null,
        log,
      })
      if (!woken.ok) {
        mergeReason = woken.reason || 'wake-failed'
        log(`执行评价归纳未叫醒：${mergeReason}`)
      } else {
        const reply = await waitReply(opts.ctx, woken.sessionId, { timeoutMs: 90_000 })
        newSummary = parseMergedSummary(reply.ok ? reply.text : '')
        if (!newSummary) {
          mergeReason = reply.reason || 'empty-summary'
        }
      }
    } else {
      mergeReason = 'no-ctx'
    }
  } catch (e) {
    mergeReason = String(e?.message ?? e).slice(0, 160)
    log(`执行评价归纳失败：${mergeReason}`)
  }

  if (!newSummary) {
    newSummary = localMergeRunFeedback(learn.understanding?.summary || '', {
      rating: ratingLabel,
      comment,
    })
    mergeVia = 'local'
    if (!mergeReason) mergeReason = 'local-fallback'
    log(`执行评价回落本地合并（${mergeReason}）`)
  } else {
    mergeVia = 'llm'
  }

  if (newSummary) {
    const now = new Date().toISOString()
    const constraints = comment
      ? constraintsFromNotes(comment, learn.understanding?.constraints || [])
      : (learn.understanding?.constraints || [])
    learn.understanding = {
      ...(learn.understanding || {}),
      summary: newSummary,
      constraints,
    }
    learn.updatedAt = now
    const lp = learnedPaths(home, id)
    const ap = automationPaths(home, id)
    await writeFile(lp.learn, `${JSON.stringify(learn, null, 2)}\n`, 'utf8')
    const task = await readAutomationTask(home, id)
    if (task) {
      task.updatedAt = now
      await writeFile(ap.task, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
    }
    const playbook = await readAutomationPlaybook(home, id)
    if (playbook) {
      playbook.understanding = playbook.understanding || {}
      playbook.understanding.summary = newSummary
      playbook.understanding.constraints = constraints
      if (playbook.strategy) playbook.strategy.summary = newSummary
      await writeFile(ap.playbook, `${JSON.stringify(playbook, null, 2)}\n`, 'utf8')
    }
    try {
      await writeGlanceSkillFile({
        goal: learn.goal,
        learnedId: id,
        automationId: id,
        summary: newSummary,
      })
    } catch (e) {
      log(`评价后更新 skill 失败：${e?.message ?? e}`)
    }
    merged = true
    if (mergeVia === 'llm') mergeReason = null
  }

  await patchLearnedRun(home, id, runId, {
    rating,
    comment,
    ratedAt: new Date().toISOString(),
    refined: merged,
  })

  return {
    ok: true,
    merged,
    mergeReason,
    mergeVia,
    rating,
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
