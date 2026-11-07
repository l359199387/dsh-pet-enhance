/**
 * 教学变通：总结目的、提出更快路径，教完多问几句，执行不机械复刻。
 *
 * @module src/teach-smart.js
 */

import { buildC3DisciplineBlock } from './c3-task.js'

/**
 * @param {string} goal
 * @param {string} narrative
 * @param {object[]} [images]
 */
export function buildTeachSmartDigestPrompt(goal, narrative, images) {
  const list = Array.isArray(images) ? images : null
  const mosaic = list?.[0]?.mosaic ? list[0] : null
  const cellCount = mosaic
    ? (Number(mosaic.sourceCount) || mosaic.cells?.length || 1)
    : (list ? list.length : Number(images) || 0)
  const attachLine = mosaic
    ? `附图 1 张拼图（约 222 token），内含 ${cellCount} 格证据（按格号看点击坐标；不是必须逐步复刻的脚本）。`
    : `附图 ${cellCount} 张（证据，不是必须逐步复刻的脚本）。`
  return (
    `【教学理解·仅学习·要变通】目标草稿：「${String(goal || '').slice(0, 80)}」。`
    + `${attachLine}\n`
    + `步骤摘要：\n${String(narrative || '').slice(0, 700)}\n`
    + '请拆解主人真正想达成的结果。若有电脑更快的方式（打开网址、写/编辑文件、快捷键、命令），'
    + '优先写快捷路径，不要鼓励机械复刻每一次点击。\n'
    + '回复格式（两行）：\n'
    + 'OK: <一两句说明在教什么>\n'
    + 'FAST: <最快达成路径；例：浏览器打开 https://www.bilibili.com ；或用写文件创建当日心情笔记>\n'
    + '看不清只回复 NEED_MORE。禁止调用 act。'
  )
}

/**
 * @param {string} text
 * @returns {{ ok: boolean, needMore: boolean, summary: string, fastPlan: string }}
 */
export function parseTeachSmartReply(text) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, needMore: true, summary: '', fastPlan: '' }
  if (/NEED_MORE|看不清|不够|再给图/i.test(raw) && !/^OK\s*[:：]/im.test(raw)) {
    return { ok: false, needMore: true, summary: raw.slice(0, 200), fastPlan: '' }
  }
  const okM = raw.match(/OK\s*[:：]\s*([^\n]+)/i)
  const fastM = raw.match(/FAST\s*[:：]\s*([\s\S]+?)(?=\n\s*[A-Z]{2,}\s*[:：]|$)/i)
  const summary = (okM ? okM[1] : raw.split('\n')[0]).trim().slice(0, 500)
  const fastPlan = (fastM ? fastM[1] : '').trim().slice(0, 600)
  return {
    ok: true,
    needMore: false,
    summary,
    fastPlan,
  }
}

/**
 * 教完必问（至少 3 条）；可与 detectTeachAmbiguities 合并去重。
 * @param {string} goal
 * @param {object[]} steps
 * @param {{ summary?: string, fastPlan?: string }} [smart]
 * @returns {{ code: string, summary: string }[]}
 */
export function buildTeachFollowupQuestions(goal, steps, smart = {}) {
  const g = String(goal || smart.summary || '这件事').trim().slice(0, 40)
  const qs = [
    {
      code: 'purpose',
      summary: `最终目的是不是「${g}」？若还有别的结果要求，请先说清再点「好」。`,
    },
    {
      code: 'fast-ok',
      summary: smart.fastPlan
        ? `我打算用更快方式：${String(smart.fastPlan).slice(0, 120)}。可以变通、不必逐步点鼠标吗？`
        : '若有打开网址 / 写文件 / 快捷键等更快方式，我可以变通达成，不必逐步复刻点击。同意吗？',
    },
    {
      code: 'adapt',
      summary: '以后界面或日期变了，要以「达成目的」为准（智能变通），而不是死复刻每一步——可以吗？',
    },
  ]
  if (!steps?.length) {
    qs.unshift({ code: 'empty', summary: '这轮没记到步骤，要重新教一遍吗？' })
  }
  return qs
}

/**
 * 合并歧义问句：强制至少问清 purpose/fast/adapt。
 * @param {{ code: string, summary: string }[]} base
 * @param {{ code: string, summary: string }[]} mandatory
 */
export function mergeTeachQuestions(base, mandatory) {
  const seen = new Set()
  const out = []
  for (const q of [...(mandatory || []), ...(base || [])]) {
    if (!q?.code || seen.has(q.code)) continue
    seen.add(q.code)
    out.push(q)
  }
  return out
}

/**
 * 执行时叫醒主会话的智能提示（优先快捷路径）。
 * @param {{ goal?: string, strategy?: { fastPlan?: string, summary?: string }, id?: string }} playbook
 */
export function buildSmartRunPrompt(playbook, extras = {}) {
  const goal = String(playbook?.goal || '').slice(0, 120)
  const fast = String(playbook?.strategy?.fastPlan || '').slice(0, 400)
  const summary = String(playbook?.strategy?.summary || playbook?.understanding?.summary || '').slice(0, 300)
  const notes = String(extras.ownerNotes || playbook?.ownerNotes || '').trim().slice(0, 400)
  return (
    `【小蓝鲸交办】执行已学会的自动化「${goal}」。`
    + (summary ? `学习理解：${summary}。` : '')
    + (notes ? `主人想法：${notes}。` : '')
    + (fast
      ? `优先按快捷路径做：${fast}。不要机械复刻教学时的每一次点击坐标；`
      : '请拆解目标，用电脑最快方式达成（网址/文件/快捷键优先于逐步点鼠标）；')
    + '先 glance 看清当前屏幕再 act。'
    + buildC3DisciplineBlock({ includeScenario: false })
    + '一两句汇报。'
    + (playbook?.id ? `（learnedId=${playbook.id}）` : '')
  )
}
