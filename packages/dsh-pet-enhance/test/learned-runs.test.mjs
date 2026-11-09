import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createLearnedAutomationPair } from '../src/learned-automation.js'
import { buildPlaybook } from '../src/teach-store.js'
import { getLearnedDetail, rateLearnedRun } from '../src/learned-manage.js'
import {
  appendLearnedRun,
  listLearnedRuns,
  normalizeRating,
} from '../src/learned-runs.js'
import { buildRunFeedbackMergePrompt, parseMergedSummary } from '../src/learned-merge.js'

const home = mkdtempSync(join(tmpdir(), 'glance-runs-'))
const prevDsh = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (prevDsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDsh
  rmSync(home, { recursive: true, force: true })
})

test('normalizeRating', () => {
  assert.equal(normalizeRating('好'), 'good')
  assert.equal(normalizeRating('一般'), 'ok')
  assert.equal(normalizeRating('差'), 'bad')
  assert.equal(normalizeRating('nope'), null)
})

test('append / list runs；评价后改正理解', async () => {
  const id = 'run-bili-1'
  const playbook = buildPlaybook('我教你看看B站', [
    { action: 'type', text: 'ok', window: 'Edge' },
  ], id)
  await createLearnedAutomationPair(home, {
    id,
    goal: '我教你看看B站',
    teachSessionId: id,
    understanding: { summary: '打开B站随便点', stats: playbook.stats, clarified: [] },
    evidence: [],
    playbook,
  })

  const run = await appendLearnedRun(home, id, {
    via: 'smart',
    ok: true,
    summary: '打开了B站但关了宠物',
  })
  const listed = await listLearnedRuns(home, id)
  assert.equal(listed[0].id, run.id)

  const detail0 = await getLearnedDetail(home, id)
  assert.equal(detail0.runs.length, 1)

  const r = await rateLearnedRun(home, id, run.id, {
    rating: '差',
    comment: '不要关掉桌面宠物，应打开 bilibili.com',
  }, {
    ctx: { get() { return null } },
    async wake(_ctx, opts) {
      assert.match(opts.text, /主人评价/)
      return { ok: true, sessionId: 's1' }
    },
    async waitReply() {
      return { ok: true, text: 'SUMMARY: 打开 bilibili.com 刷视频，全程保持桌面宠物可见。' }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.merged, true)
  assert.match(r.detail.understanding, /bilibili|宠物/)
  assert.equal(r.detail.runs[0].rating, 'bad')
  assert.equal(r.detail.runs[0].refined, true)
})

test('buildRunFeedbackMergePrompt', () => {
  const p = buildRunFeedbackMergePrompt({
    goal: '看看B站',
    summary: '旧理解',
    runSummary: '失败了',
    rating: '差',
    comment: '别盲点',
    ok: false,
  })
  assert.match(p, /旧理解/)
  assert.match(p, /别盲点/)
  assert.equal(parseMergedSummary('SUMMARY: 新理解'), '新理解')
})

test('评价：模型失败时本地回落改正理解', async () => {
  const id = 'run-local-1'
  const playbook = buildPlaybook('记录心情', [
    { action: 'type', text: 'ok', window: '记事本' },
  ], id)
  await createLearnedAutomationPair(home, {
    id,
    goal: '记录心情',
    teachSessionId: id,
    understanding: { summary: '每次新建日期_时间文件', stats: playbook.stats, clarified: [] },
    evidence: [],
    playbook,
  })
  const run = await appendLearnedRun(home, id, {
    via: 'smart',
    ok: true,
    summary: '又新建了一个文件',
  })
  const r = await rateLearnedRun(home, id, run.id, {
    rating: 'ok',
    comment: '同一天的需要在同一个文件中,文件名用日期.txt',
  }, {
    ctx: { get() { return null } },
    async wake() { return { ok: false, reason: 'no' } },
  })
  assert.equal(r.ok, true)
  assert.equal(r.merged, true)
  assert.equal(r.mergeVia, 'local')
  assert.equal(r.detail.runs[0].refined, true)
  assert.match(r.detail.understanding, /日期\.txt|同一个文件/)
})
