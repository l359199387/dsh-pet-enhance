/**
 * 薄胶水：看屏/GUI 操控委托给已安装的 dsh-computer-use-win（主会话工具）。
 * 本插件不 import / 不调用其内部 API。
 *
 * @module src/computer-use-delegate.js
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_WAKE_PREFIX, GLANCE_FOLLOWUP_PREFIX, TEACH_FOLLOWUP_PREFIX } from './intent.js'
import { glancePersonaBlock } from './persona.js'

export const COMPUTER_USE_TOOL_PREFIX = 'windows_computer_use_'

export const COMPUTER_USE_MISSING_BUBBLE =
  '本机还没装「电脑操控」插件（dsh-computer-use-win）。'
  + '请先安装并完全退出再打开 DSH，然后再让我看屏或操作桌面。'

/** 观察类短名（提示用）。 */
export const COMPUTER_USE_OBSERVE_TOOLS = Object.freeze([
  'list_windows',
  'snapshot',
  'accessibility_tree',
  'find',
  'element_info',
  'screenshot',
  'ocr',
  'wait_for',
])

/** GUI 操作类短名（提示用）。 */
export const COMPUTER_USE_ACT_TOOLS = Object.freeze([
  'click',
  'double_click',
  'type_text',
  'keypress',
  'set_value',
  'invoke',
  'focus',
  'activate_window',
  'launch_app',
  'scroll',
  'batch',
])

function profileDesktopRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', 'desktop')
}

/**
 * 轻量探测 desktop profile 是否装了 dsh-computer-use-win（不 import 包）。
 * @param {string} [profileRoot]
 */
export function isComputerUseInstalled(profileRoot = profileDesktopRoot()) {
  try {
    if (existsSync(join(profileRoot, 'node_modules', 'dsh-computer-use-win', 'package.json'))) {
      return true
    }
    const patch = join(profileRoot, 'cordis.patch.yml')
    if (!existsSync(patch)) return false
    const raw = readFileSync(patch, 'utf8')
    return /dsh-computer-use-win/.test(raw)
  } catch {
    return false
  }
}

export function buildComputerUseDisciplineBlock() {
  return (
    '【电脑操控·委托 dsh-computer-use-win】'
    + `1. 看屏与 GUI 只用 \`${COMPUTER_USE_TOOL_PREFIX}*\` 工具（如 list_windows / snapshot / find / screenshot / ocr / set_value / invoke / type_text / click）。`
    + '2. **禁止**调用已下线的 `glance` / `act`。'
    + '3. 优先 UI Automation：find → set_value / invoke；少用屏幕坐标盲点。'
    + '4. 聊天 App（豆包等）：先 list_windows/find 目标窗，新建会话再输入；发送优先 invoke/点发送控件。'
    + '5. 文件/命令/已学会的 Python 脚本仍可用宿主工具；做完用一两句口语汇报。'
    + '6. 用户急停或 computer-use 的 Esc 停止 → 立刻停，不要重试。'
  )
}

/**
 * 「看一眼」类：只观察。
 * @param {string} userText
 */
export function buildComputerUseObservePrompt(userText) {
  const raw = String(userText ?? '').trim().slice(0, 200)
  return (
    `${AGENT_WAKE_PREFIX}${GLANCE_FOLLOWUP_PREFIX}`
    + `用户通过桌宠小蓝鲸说：「${raw}」。`
    + '请用电脑操控工具**只观察屏幕**（list_windows / snapshot / screenshot / ocr / find），'
    + '用一两句口语说明你看到了什么；不要操作鼠标键盘除非用户明确要求改界面。'
    + buildComputerUseDisciplineBlock()
    + `\n\n${glancePersonaBlock()}`
  )
}

/**
 * 交办/GUI：观察 + 可操作。
 * @param {string} userText
 * @param {{ notepad?: boolean }} [opts]
 */
export function buildComputerUseActPrompt(userText, opts = {}) {
  const raw = String(userText ?? '').trim().slice(0, 200)
  const notepad = Boolean(opts.notepad)
  return (
    `${AGENT_WAKE_PREFIX}`
    + `用户通过桌宠小蓝鲸说：「${raw}」。`
    + (notepad
      ? '这像是写日期/桌面文件类任务：能脚本或写文件就优先；否则用电脑操控操作记事本 GUI。'
      : '请理解意图后完成任务。')
    + buildComputerUseDisciplineBlock()
    + '完成后用一两句口语汇报结果（成功/失败/卡在哪）。'
    + `\n\n${glancePersonaBlock()}`
  )
}

/**
 * 带教本步 / 学会变通。
 * @param {string} body 已拼好的任务正文（不含前缀亦可）
 */
export function appendComputerUseTeachHints(body) {
  return (
    `${String(body || '')}`
    + buildComputerUseDisciplineBlock()
    + `\n${glancePersonaBlock()}`
  )
}

export function teachFollowUpPrefix() {
  return `${AGENT_WAKE_PREFIX}${TEACH_FOLLOWUP_PREFIX}`
}
