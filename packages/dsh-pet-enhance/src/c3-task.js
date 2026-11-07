/**
 * C3 端到端验收：真实任务闭环纪律（glance → act → 验证）。
 *
 * 标准剧本（docs/04）：打开记事本 → 写下今天日期 → 保存到桌面 → 关掉。
 *
 * @module src/c3-task.js
 */

/** 验收剧本一句话目标（给人 / 冒烟用）。 */
export const C3_ACCEPTANCE_GOAL =
  '打开记事本，写下今天的日期，保存到桌面，然后关掉'

/** 路线图：全流程动作数建议上限。 */
export const C3_MAX_ACTIONS = 30

/** 单步失败/可能没生效时，最多额外重试次数。 */
export const C3_STEP_RETRY = 1

/**
 * 是否像 C3 记事本验收口令（粗筛，仅用于加强提示，不强制走脚本）。
 * @param {string} text
 */
export function isC3NotepadIntent(text) {
  const s = String(text || '')
  if (!/记事本|notepad/i.test(s)) return false
  return /日期|今天|保存|桌面|关掉|关闭/.test(s)
}

/**
 * 写入工具/交办提示的执行纪律（模型可见）。
 * @param {{ includeScenario?: boolean }} [opts]
 */
export function buildC3DisciplineBlock(opts = {}) {
  const includeScenario = opts.includeScenario !== false
  const lines = [
    '【动手纪律·C3】',
    '1. 看不清就先 `glance`；一次 `act` 只做一个动作；关键步（打开/输入/保存/关闭）后应再 `glance` 确认。坐标必须用**当次** glance 看到的物理像素，勿凭记忆或教学旧坐标估点。',
    '1b. 整屏糊、小字/图标看不清：对目标区域 `glance({action:"zoom", region:"x,y,w,h"})`（默认高清）或 `quality:"high"`；**禁止对着糊图瞎猜乱点**。',
    `2. 若 act 回报「可能没生效」或 glance 显示没变化：同一意图最多再试 ${C3_STEP_RETRY} 次；仍失败则停，用一两句说明卡在哪，不要换花样连点。`,
    '3. 用户急停、甩光标到左上角、点「不要」、或预算用尽 → 立刻停，不要重试。',
    `4. 本轮动作宜 ≤ ${C3_MAX_ACTIONS}；优先快捷键/对话框，少盲点坐标。`,
    '5. 「另存为」：优先 type 完整路径（如桌面\\\\日期.txt）再 key Enter；或 Alt+N 聚焦文件名框。不要反复点左侧「桌面」或乱点坐标。参数必须是合法 JSON。',
  ]
  if (includeScenario) {
    lines.push(
      `6. 若用户要验收记事本闭环，目标是：${C3_ACCEPTANCE_GOAL}；`
        + '日期用当天本地日期；保存到用户桌面（文件名清晰即可）；确认弹窗等用户点「好」。',
    )
  }
  return lines.join('')
}

/** act 回报「可能没生效」时的模型可见提示。 */
export function c3MaybeNoopHint() {
  return (
    `画面几乎没变，可能没生效——请先 glance 确认；`
    + `同一意图最多再试 ${C3_STEP_RETRY} 次，仍失败就停并说明卡在哪。`
  )
}

/** 预算用尽时宠物气泡（用户可见）。 */
export function c3BudgetExceededBubble() {
  return '这轮动作次数用完了。再说一次「去看看… / 执行一下…」，我会开新一轮再试。'
}

/**
 * 供本地冒烟/文档列出的验收清单。
 * @returns {{ id: string, title: string, check: string }[]}
 */
export function c3AcceptanceChecklist() {
  return [
    {
      id: 'c3-flow',
      title: '全流程',
      check: '无人工干预完成（L2 确认弹窗除外）',
    },
    {
      id: 'c3-file',
      title: '桌面文件',
      check: '桌面出现保存的记事本文件，正文含当天日期',
    },
    {
      id: 'c3-orphan',
      title: '无孤儿进程',
      check: '中途结束 DSH 后 sidecar 一并退出',
    },
    {
      id: 'c3-budget',
      title: '成本',
      check: `动作数 ≤ ${C3_MAX_ACTIONS}（路线图另有 token ≤ 15k 人工观察）`,
    },
  ]
}
