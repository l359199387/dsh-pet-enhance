/**
 * 把小蓝鲸学会的自动化登记到 DeepSeek Harness 的 schedule（自动化任务页）。
 *
 * 宿主真实签名（当前安装版）：
 *   schedule.create(sessionId, { title, prompt, after_seconds|at|… }, signal?)
 * 返回 record（含 id）。无 pause API 时用一年后的 after_seconds，避免教完立刻投递。
 *
 * @module src/harness-schedule.js
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { serviceOf } from './host-ctx.js'
import { pickSessionId } from './wake-session.js'

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
    + '先 glance 看清**当前**屏幕，再按目标用 act。'
    + '不要加载 learned/frames 教学图片（图只用于学习，执行不用）。'
    + '点击坐标只是参考，界面变了要 glance 重找；'
    + 'playbook 里 mode=script 的「用户键入文字」可按 text 复打；敏感输入只用 secretRef。一两句汇报。'
  )
}

export function buildSkillMarkdown({ name, goal, learnedId, automationId, summary }) {
  return (
    `---\n`
    + `name: ${name}\n`
    + `description: ${clip(goal, 120)}（小蓝鲸教学·与自动化一一对应）。执行前先 glance；文字步骤按 text 复打。\n`
    + `---\n\n`
    + `# ${clip(goal, 80)}\n\n`
    + `- learnedId: \`${learnedId}\`\n`
    + `- automationId: \`${automationId}\`\n`
    + `- 路径: \`~/.dsh/glance/learned/${learnedId}/\`\n\n`
    + `## 理解摘要\n\n${clip(summary, 800)}\n\n`
    + `## 执行纪律\n\n`
    + `1. 先 glance，再 act。\n`
    + `2. 点击坐标仅为证据，界面变了要重找；typed-text 按记录的文字复打。\n`
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

/** 一年后才到点，避免教完立刻往会话灌指令；可在自动化页查看/管理。 */
export const DEFAULT_AFTER_SECONDS = 365 * 24 * 3600

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
  // 标题用目标；避免奇怪前缀导致校验歧义
  const title = clip(String(goal || learnedId || '小蓝鲸自动化').trim() || '小蓝鲸自动化', 120)

  const schedule = serviceOf(ctx, 'schedule')
  if (!schedule?.create) {
    return {
      ok: false,
      skillName,
      reason: 'no-schedule-service',
    }
  }

  const sessionId = preferredSessionId || pickSessionId(ctx, null)
  if (!sessionId) {
    return {
      ok: false,
      skillName,
      reason: 'no-session-for-schedule',
    }
  }

  const request = {
    title,
    prompt,
    after_seconds: DEFAULT_AFTER_SECONDS,
  }

  try {
    // 真实签名：create(sessionId, request, signal?) → record
    const created = await schedule.create(sessionId, request)
    const scheduleId = created?.id || created?.record?.id || created?.task?.id
    if (!scheduleId) {
      return { ok: false, skillName, reason: 'create-no-id', raw: created }
    }
    log(`Harness 自动化已登记 ${scheduleId}（after 1y，绑定会话 ${sessionId}） skill=${skillName}`)
    return { ok: true, scheduleId: String(scheduleId), skillName, sessionId: String(sessionId) }
  } catch (e) {
    const msg = String(e?.message ?? e)
    log(`Harness schedule.create 失败：${msg}`)
    return { ok: false, skillName, reason: msg.slice(0, 200) }
  }
}
