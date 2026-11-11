/**
 * 把小蓝鲸学会的技能登记到 DeepSeek Harness 的 schedule（自动化任务页）。
 *
 * 规则：用户没明确说「每周几 / 几点 / 每隔…」→ 只写 skill，**不** create 定时。
 * 技能权威：~/.dsh/skills/<name>/SKILL.md
 *
 * @module src/harness-schedule.js
 */

import { serviceOf } from './host-ctx.js'
import { pickSessionId } from './wake-session.js'
import { parseScheduleSpec, timingToCreateFields } from './schedule-parse.js'
import {
  buildTeachSkillMarkdown,
  skillSlugFromGoal,
  writeTeachSkillFile,
} from './teach-skill.js'

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/** DSH skill 名必须 kebab-case（仅 a-z0-9-）。 */
export function skillSlugFromId(id) {
  const tail = String(id || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase() || 'x'
  return `pe-learn-${tail}`
}

export { skillSlugFromGoal }

/**
 * 交给 Harness 自动化 / Agent 的短指令。
 */
export function buildHarnessAutomationPrompt({
  goal,
  skillName,
  ownerNotes = '',
}) {
  const notes = String(ownerNotes || '').trim()
  return (
    `执行小蓝鲸已学会的技能「${clip(goal, 80)}」。`
    + `可用 skill「${skillName}」加载说明与 scripts。`
    + (notes ? `主人想法：${clip(notes, 400)}。` : '')
    + '优先跑 ready 脚本；不够再用 windows_computer_use_*（优先 UIA）。'
    + '禁止调用已下线的 glance/act。一两句汇报。'
  )
}

/** @deprecated 兼容旧测试；新路径用 buildTeachSkillMarkdown。 */
export function buildSkillMarkdown({ name, goal, learnedId, automationId, summary }) {
  return buildTeachSkillMarkdown({
    name,
    goal,
    summary,
    teachSessionId: learnedId || '',
    scheduleId: null,
  }) + (learnedId || automationId
    ? `\n<!-- legacy learnedId=${learnedId || ''} automationId=${automationId || ''} -->\n`
    : '')
}

/**
 * 写入 ~/.dsh/skills/<slug>/SKILL.md
 */
export async function writeGlanceSkillFile({
  goal,
  learnedId,
  automationId,
  summary,
  fastPlan,
  constraints,
  name,
}) {
  const skillName = name || skillSlugFromGoal(goal, learnedId || automationId)
  return writeTeachSkillFile({
    name: skillName,
    goal,
    summary,
    fastPlan,
    constraints,
    teachSessionId: learnedId || '',
  })
}

/** @deprecated 不再用作默认定时；仅测试/显式 after 兼容。 */
export const DEFAULT_AFTER_SECONDS = 365 * 24 * 3600

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   scheduled?: boolean,
 *   scheduleId?: string,
 *   skillName?: string,
 *   reason?: string,
 *   timingLabel?: string,
 *   sessionId?: string,
 * }>}
 */
export async function registerHarnessAutomation(ctx, {
  goal,
  learnedId,
  automationId,
  summary,
  fastPlan,
  constraints,
  skillName: preferredName,
  preferredSessionId = null,
  scheduleText = '',
  timing = null,
  log = () => {},
} = {}) {
  let skillName = preferredName || skillSlugFromGoal(goal, learnedId || automationId)
  try {
    const sk = await writeTeachSkillFile({
      name: skillName,
      goal,
      summary,
      fastPlan,
      constraints,
      teachSessionId: learnedId || '',
    })
    skillName = sk.name
  } catch (e) {
    log(`写 skill 失败：${e?.message ?? e}`)
  }

  const prompt = buildHarnessAutomationPrompt({
    goal,
    skillName,
  })
  const rawGoal = String(goal || skillName || '自动化').trim() || '自动化'
  const titled = rawGoal.startsWith('小蓝鲸') ? rawGoal : `小蓝鲸｜${rawGoal}`
  const title = clip(titled, 120)

  const spec = timing || parseScheduleSpec(scheduleText, goal, summary)
  if (!spec) {
    log(`Harness：未说明运行时间，跳过 schedule.create（仅 skill=${skillName}）`)
    return {
      ok: true,
      scheduled: false,
      skillName,
      reason: 'no-schedule-requested',
    }
  }

  const timingFields = timingToCreateFields(spec)
  if (!timingFields) {
    return {
      ok: true,
      scheduled: false,
      skillName,
      reason: 'timing-unsupported',
    }
  }

  const schedule = serviceOf(ctx, 'schedule')
  if (!schedule?.create) {
    return {
      ok: false,
      scheduled: false,
      skillName,
      reason: 'no-schedule-service',
    }
  }

  const sessionId = preferredSessionId || pickSessionId(ctx, null)
  if (!sessionId) {
    return {
      ok: false,
      scheduled: false,
      skillName,
      reason: 'no-session-for-schedule',
    }
  }

  const request = {
    title,
    prompt,
    ...timingFields,
  }

  try {
    const created = await schedule.create(sessionId, request)
    const scheduleId = created?.id || created?.record?.id || created?.task?.id
    if (!scheduleId) {
      return { ok: false, scheduled: false, skillName, reason: 'create-no-id', raw: created }
    }
    log(
      `Harness 定时已登记 ${scheduleId}（${spec.label}，绑定会话 ${sessionId}） skill=${skillName}`,
    )
    return {
      ok: true,
      scheduled: true,
      scheduleId: String(scheduleId),
      skillName,
      sessionId: String(sessionId),
      timingLabel: spec.label,
    }
  } catch (e) {
    const msg = String(e?.message ?? e)
    log(`Harness schedule.create 失败：${msg}`)
    return { ok: false, scheduled: false, skillName, reason: msg.slice(0, 200) }
  }
}

export { parseScheduleSpec, timingToCreateFields, hasExplicitScheduleIntent } from './schedule-parse.js'
