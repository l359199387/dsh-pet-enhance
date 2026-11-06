/**
 * 把主人想法归纳进小蓝鲸「学习理解」。
 *
 * @module src/learned-merge.js
 */

export const LEARNED_MERGE_PREFIX = '【小蓝鲸归纳·禁止工具】'

/**
 * @param {{ goal?: string, summary?: string, ownerNotes?: string }} input
 */
export function buildOwnerNotesMergePrompt(input = {}) {
  const goal = String(input.goal || '').slice(0, 120)
  const summary = String(input.summary || '').slice(0, 600)
  const notes = String(input.ownerNotes || '').slice(0, 800)
  return (
    `${LEARNED_MERGE_PREFIX}\n`
    + `目标：「${goal}」\n`
    + `当前学习理解：${summary || '（尚无）'}\n`
    + `主人补充：${notes || '（空）'}\n\n`
    + '请把主人补充**归纳合并**进学习理解：保留原理解里仍然正确的部分，吸收偏好与约束，去掉重复，写成一段连贯中文（约 80–200 字）。\n'
    + '只输出一行：\n'
    + 'SUMMARY: <合并后的学习理解>\n'
    + '禁止调用任何工具，不要解释，不要复述主人原文当口号。'
  )
}

/**
 * 根据一次执行评价改正学习理解。
 * @param {{
 *   goal?: string,
 *   summary?: string,
 *   runSummary?: string,
 *   via?: string,
 *   ok?: boolean,
 *   rating?: string,
 *   comment?: string,
 * }} input
 */
export function buildRunFeedbackMergePrompt(input = {}) {
  const goal = String(input.goal || '').slice(0, 120)
  const summary = String(input.summary || '').slice(0, 600)
  const runSummary = String(input.runSummary || '').slice(0, 400)
  const via = String(input.via || '').slice(0, 40)
  const rating = String(input.rating || '').slice(0, 16)
  const comment = String(input.comment || '').slice(0, 400)
  const okLabel = input.ok === false ? '失败/中断' : '自称完成'
  return (
    `${LEARNED_MERGE_PREFIX}\n`
    + `目标：「${goal}」\n`
    + `当前学习理解：${summary || '（尚无）'}\n`
    + `本次执行：途径=${via || '未知'}，结果=${okLabel}；摘要：${runSummary || '（无）'}\n`
    + `主人评价：${rating || '未标注'}${comment ? `；评语：${comment}` : ''}\n\n`
    + '请根据评价**改正**学习理解：吸收主人指出的问题与偏好，删掉已被否定的做法，保留仍正确的部分，写成一段连贯中文（约 80–200 字）。\n'
    + '若评价为「好」且评语为空，可微调表述让下次更容易成功；若为「差」，必须明显修正策略。\n'
    + '只输出一行：\n'
    + 'SUMMARY: <改正后的学习理解>\n'
    + '禁止调用任何工具，不要解释。'
  )
}

/**
 * @param {string} text
 * @returns {string}
 */
export function parseMergedSummary(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const m = raw.match(/SUMMARY\s*[:：]\s*([\s\S]+)/i)
  let body = (m ? m[1] : raw).trim()
  body = body.replace(/^["「]|["」]$/g, '').trim()
  // 去掉模型可能追加的第二段
  const line = body.split(/\n/)[0].trim()
  return line.slice(0, 800)
}
