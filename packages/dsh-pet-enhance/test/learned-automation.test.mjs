import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  assertLearnedAutomationPair,
  createLearnedAutomationPair,
  findAutomationForQuery,
  listLearnedIndex,
} from '../src/learned-automation.js'
import { buildPlaybook, buildPublicPlan } from '../src/teach-store.js'

const home = mkdtempSync(join(tmpdir(), 'glance-la-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('学习文件与自动化同 id 一一对应', async () => {
  const steps = buildPublicPlan([
    { kind: 'key', i: 0, keys: 'ctrl+s', window: { title: '记事本' } },
    { kind: 'type', i: 1, text: 'hi', window: { title: '记事本' } },
  ])
  const playbook = buildPlaybook('保存心情', steps, 'pair-1')
  const pair = await createLearnedAutomationPair(home, {
    id: 'pair-1',
    goal: '保存心情',
    teachSessionId: 'pair-1',
    understanding: { summary: '按 ctrl+s 并输入', stats: playbook.stats, clarified: ['short'] },
    evidence: steps,
    playbook,
  })
  assert.equal(pair.learn.automationId, 'pair-1')
  assert.equal(pair.task.learnedId, 'pair-1')
  const check = await assertLearnedAutomationPair(home, 'pair-1')
  assert.equal(check.ok, true)
  const idx = await listLearnedIndex(home)
  assert.equal(idx[0].id, 'pair-1')
  const auto = await findAutomationForQuery(home, '再做一次刚才教的')
  assert.equal(auto?.id, 'pair-1')
  assert.equal(auto?.learnedId, 'pair-1')
  const byGoal = await findAutomationForQuery(home, '执行一下保存心情')
  assert.equal(byGoal?.id, 'pair-1')
  const byLoose = await findAutomationForQuery(home, '去保存一下心情')
  assert.equal(byLoose?.id, 'pair-1')
  const byLearnedPhrase = await findAutomationForQuery(home, '用你学会的保存心情')
  assert.equal(byLearnedPhrase?.id, 'pair-1')
})

test('口语「继续去看看B站」能匹配教学 goal', async () => {
  const steps = buildPublicPlan([
    { kind: 'type', i: 0, text: 'hello', window: { title: 'Edge' } },
  ])
  const playbook = buildPlaybook('我教你看看B站', steps, 'bili-1')
  await createLearnedAutomationPair(home, {
    id: 'bili-1',
    goal: '我教你看看B站',
    teachSessionId: 'bili-1',
    understanding: { summary: '打开 bilibili 刷视频', stats: playbook.stats, clarified: [] },
    evidence: steps,
    playbook,
  })
  const hit = await findAutomationForQuery(home, '继续去看看B站')
  assert.equal(hit?.id, 'bili-1')
  const hit2 = await findAutomationForQuery(home, '去刷刷B站')
  assert.equal(hit2?.id, 'bili-1')
})
