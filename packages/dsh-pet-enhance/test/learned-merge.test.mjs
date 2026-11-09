import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_WAKE_PREFIX } from '../src/intent.js'
import {
  buildOwnerNotesMergePrompt,
  buildRunFeedbackMergePrompt,
  constraintsFromNotes,
  localMergeOwnerNotes,
  localMergeRunFeedback,
  parseMergedSummary,
  LEARNED_MERGE_PREFIX,
} from '../src/learned-merge.js'

test('merge prompt 含理解与主人想法', () => {
  const p = buildOwnerNotesMergePrompt({
    goal: '记心情',
    summary: '打开记事本写一句',
    ownerNotes: '写到桌面文件夹',
  })
  assert.ok(p.startsWith(AGENT_WAKE_PREFIX))
  assert.ok(p.includes(LEARNED_MERGE_PREFIX))
  assert.match(p, /打开记事本/)
  assert.match(p, /写到桌面文件夹/)
  assert.match(p, /SUMMARY:/)
})

test('parseMergedSummary', () => {
  assert.equal(parseMergedSummary('SUMMARY: 合并后的理解'), '合并后的理解')
  assert.equal(parseMergedSummary('SUMMARY：另一句\n下一行也算'), '另一句 下一行也算')
})

test('执行评价改正 prompt', () => {
  const p = buildRunFeedbackMergePrompt({
    goal: '看看B站',
    summary: '随便点',
    runSummary: '关了宠物',
    rating: '差',
    comment: '宠物要一直在',
    ok: true,
  })
  assert.ok(p.startsWith(AGENT_WAKE_PREFIX))
  assert.match(p, /宠物要一直在/)
  assert.match(p, /SUMMARY:/)
})

test('localMergeOwnerNotes / localMergeRunFeedback / constraintsFromNotes', () => {
  assert.match(
    localMergeOwnerNotes('旧理解', '用日期.txt 复用'),
    /日期\.txt/,
  )
  assert.match(
    localMergeRunFeedback('旧理解', { rating: '一般', comment: '同一天同一个文件' }),
    /同一个文件/,
  )
  assert.deepEqual(
    constraintsFromNotes('用日期.txt\n同一天复用', ['已有']),
    ['已有', '用日期.txt', '同一天复用'],
  )
})
