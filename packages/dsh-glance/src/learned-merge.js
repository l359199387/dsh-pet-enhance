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
