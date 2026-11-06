/**
 * 把小蓝鲸学会的自动化登记到 DeepSeek Harness 的 schedule（自动化任务页）。
 *
 * 默认创建后暂停（active=false），避免教完立刻往会话里灌指令、误动手。
 * 用户可在自动化页「立即运行」或对小蓝鲸说去做。
 *
 * @module src/harness-schedule.js
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { serviceOf } from './host-ctx.js'

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/** DSH skill 名必须 kebab-case（仅 a-z0-9-）。 */
export function skillSlugFromId(id) {
  const tail = String(id || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase() || 'x'
  return `glance-learn-${tail}`
}

/**
 * 交给 Harness 自动化 / Agent 的短指令（不含密码明文）。
 */
export function buildHarnessAutomationPrompt({ goal, learnedId, skillName }) {
  return (
    `执行小蓝鲸已学会的自动化「${clip(goal, 80)}」。`
    + `学习 id=${learnedId}；可用 skill「${skillName}」加载说明。`
    + '先 glance 看清当前屏幕，再按目标用 act 操作。'
    + '教学录制里的坐标与演示打字只是参考，禁止盲重点击或盲打录制原文；'
    + '敏感输入只用 secretRef。做完用一两句汇报。'
  )
}

export function buildSkillMarkdown({ name, goal, learnedId, automationId, summary }) {
  return (
    `---\n`
    + `name: ${name}\n`
    + `description: ${clip(goal, 120)}（小蓝鲸教学·与自动化一一对应）。执行前先 glance，勿盲打字。\n`
    + `---\n\n`
    + `# ${clip(goal, 80)}\n\n`
    + `- learnedId: \`${learnedId}\`\n`
    + `- automationId: \`${automationId}\`\n`
    + `- 路径: \`~/.dsh/glance/learned/${learnedId}/\`\n\n`
    + `## 理解摘要\n\n${clip(summary, 800)}\n\n`
    + `## 执行纪律\n\n`
    + `1. 先 glance，再 act。\n`
    + `2. 坐标与演示输入仅为证据，界面变了要重找。\n`
    + `3. 密码类只用本地 secretRef，禁止复述明文。\n`
  )
}

/**
 * 写入 ~/.dsh/skills/<slug>/SKILL.md，供 DSH 热发现。
 */
export async function writeGlanceSkillFile({ goal, learnedId, automationId, summary }) {
  const name = skillSlugFromId(learnedId)
  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(root, 'skills', name)
  await mkdir(dir, { recursive: true })
  const body = buildSkillMarkdown({
    name,
    goal,
    learnedId,
    automationId,
    summary,
  })
  const path = join(dir, 'SKILL.md')
  await writeFile(path, body, 'utf8')
  return { name, path }
}

function nextYearDtstartShanghai() {
  const y = new Date().getFullYear() + 1
  return `DTSTART;TZID=Asia/Shanghai:${y}0101T090000\nRRULE:FREQ=YEARLY;COUNT=1`
}

/**
 * @returns {Promise<{ ok: boolean, scheduleId?: string, skillName?: string, reason?: string }>}
 */
export async function registerHarnessAutomation(ctx, {
  goal,
  learnedId,
  automationId,
  summary,
  preferredSessionId = null,
  log = () => {},
} = {}) {
  let skillName = skillSlugFromId(learnedId)
  try {
    const sk = await writeGlanceSkillFile({
      goal,
      learnedId,
      automationId: automationId || learnedId,
      summary,
    })
    skillName = sk.name
  } catch (e) {
    log(`写 skill 失败：${e?.message ?? e}`)
  }

  const prompt = buildHarnessAutomationPrompt({
    goal,
    learnedId,
    skillName,
  })
  const title = clip(`小蓝鲸·${goal || learnedId}`, 120)

  const schedule = serviceOf(ctx, 'schedule')
  if (!schedule?.create) {
    return {
      ok: false,
      skillName,
      reason: 'no-schedule-service',
    }
  }

  try {
    // 服务 API（与工具字段可能不同）：优先 timing；失败再试 rrule 形参
    let created = null
    const actor = preferredSessionId || undefined
    try {
      created = await schedule.create(
        {
          title,
          prompt,
          timing: { kind: 'rrule', rrule: nextYearDtstartShanghai() },
          target: { kind: 'new_once' },
        },
        actor,
      )
    } catch {
      created = await schedule.create(
        {
          title,
          prompt,
          rrule: nextYearDtstartShanghai(),
          target: 'new_once',
        },
        actor,
      )
    }

    const scheduleId = created?.id || created?.record?.id || created?.task?.id
    if (scheduleId && typeof schedule.edit === 'function') {
      try {
        await schedule.edit(
          { id: scheduleId, action: 'update', active: false },
          actor,
        )
      } catch {
        try {
          await schedule.edit(
            { id: scheduleId, action: 'update', patch: { active: false } },
            actor,
          )
        } catch (e) {
          log(`schedule 暂停失败（任务已创建）：${e?.message ?? e}`)
        }
      }
    }

    if (!scheduleId) {
      return { ok: false, skillName, reason: 'create-no-id', raw: created }
    }
    log(`Harness 自动化已登记 ${scheduleId}（已暂停） skill=${skillName}`)
    return { ok: true, scheduleId: String(scheduleId), skillName }
  } catch (e) {
    log(`Harness schedule.create 失败：${e?.message ?? e}`)
    return { ok: false, skillName, reason: String(e?.message ?? e).slice(0, 160) }
  }
}
