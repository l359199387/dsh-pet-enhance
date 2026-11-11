/**
 * C3 任务纪律：看屏/GUI 委托 windows_computer_use_*。
 *
 * @module src/c3-task.js
 */

import { buildComputerUseDisciplineBlock } from './computer-use-delegate.js'

export const C3_ACCEPTANCE_GOAL =
  '用电脑操控或脚本完成「写日期到桌面文件」类目标'

export const C3_MAX_ACTIONS = 30
export const C3_STEP_RETRY = 1

/**
 * @param {string} text
 */
export function isC3NotepadIntent(text) {
  const s = String(text || '')
  if (!/记事本|notepad/i.test(s)) return false
  return /日期|今天|保存|桌面|关掉|关闭/.test(s)
}

/**
 * @param {{ includeScenario?: boolean }} [opts]
 */
export function buildC3DisciplineBlock(opts = {}) {
  const includeScenario = opts.includeScenario !== false
  let block = buildComputerUseDisciplineBlock()
  if (includeScenario) {
    block += `若用户要「记事本/写日期到桌面」：目标参考：${C3_ACCEPTANCE_GOAL}。`
  }
  return block
}

export function c3MaybeNoopHint() {
  return (
    `画面几乎没变——请再用 screenshot/ocr/snapshot 确认；`
    + `同一意图最多再试 ${C3_STEP_RETRY} 次，仍失败就停并说明卡在哪。`
  )
}

export function c3BudgetExceededBubble() {
  return '这轮动作次数用完了。再说一次「去看看… / 执行一下…」，我会开新一轮再试。'
}

export function c3AcceptanceChecklist() {
  return [
    {
      id: 'c3-wcu',
      title: '电脑操控',
      check: '看屏/GUI 走 windows_computer_use_*；本插件不注册 glance/act',
    },
    {
      id: 'c3-scripts',
      title: '脚本/命令',
      check: '有 ready 脚本时可跑；否则 computer-use 或口述',
    },
    {
      id: 'c3-orphan',
      title: '无孤儿进程',
      check: 'computer-use 急停/Esc 可停；本插件不再拉 sidecar',
    },
    {
      id: 'c3-budget',
      title: '成本',
      check: `轮次宜可控（参考 ≤ ${C3_MAX_ACTIONS}）`,
    },
  ]
}
