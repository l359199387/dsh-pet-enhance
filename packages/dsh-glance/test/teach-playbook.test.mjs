import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildPlaybook,
  buildPublicPlan,
  compactGlanceHints,
  detectTeachAmbiguities,
  findPlaybookForQuery,
  narratePlan,
  savePlaybook,
} from '../src/teach-store.js'

const home = mkdtempSync(join(tmpdir(), 'glance-pb-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('buildPlaybook：用户键入明文→文字 script；点击→glance；secret→script', () => {
  const steps = buildPublicPlan([
    { kind: 'click', i: 0, x: 1, y: 2, window: { title: 'A' } },
    { kind: 'key', i: 1, keys: 'enter', window: { title: 'A' } },
    { kind: 'type', i: 2, text: 'meirixinqing1', window: { title: 'A' } },
    { kind: 'type', i: 3, secretRef: 'step:3', sensitive: true, window: { title: '密码本' } },
  ])
  const pb = buildPlaybook('登录', steps, 'sid1')
  assert.equal(pb.steps[0].mode, 'glance')
  assert.equal(pb.steps[1].mode, 'script')
  assert.equal(pb.steps[2].mode, 'script')
  assert.equal(pb.steps[2].text, 'meirixinqing1')
  assert.equal(pb.steps[2].kind, 'typed-text')
  assert.equal(pb.steps[3].mode, 'script')
  assert.equal(pb.steps[3].secretRef, 'sid1/step:3')
  assert.match(compactGlanceHints(pb), /click@A/)
  assert.match(narratePlan(pb.steps), /用户键入文字「meirixinqing1」/)
})

test('detectTeachAmbiguities：目标不清 / 步少会提问', () => {
  assert.ok(detectTeachAmbiguities('完成刚才教的流程', [{ action: 'key', keys: 'a' }]).some((q) => q.code === 'goal'))
  assert.ok(detectTeachAmbiguities('保存', [{ action: 'key', keys: 'a' }]).some((q) => q.code === 'short'))
  assert.equal(detectTeachAmbiguities('保存文件', [
    { action: 'key', keys: 'ctrl+s', window: '记事本' },
    { action: 'type', text: 'x', window: '记事本' },
  ]).length, 0)
})

test('findPlaybookForQuery：刚才教的 / 目标关键词', async () => {
  await savePlaybook(home, buildPlaybook('把记事本最小化', [
    { action: 'key', keys: 'alt+f4', window: '记事本' },
    { action: 'key', keys: 'enter', window: '记事本' },
  ], 'pb-a'))
  const again = await findPlaybookForQuery(home, '再做一次刚才教的')
  assert.equal(again?.id, 'pb-a')
  const byGoal = await findPlaybookForQuery(home, '帮我把记事本最小化')
  assert.equal(byGoal?.id, 'pb-a')
})
