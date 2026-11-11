import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createLearnedAutomationPair } from '../src/learned-automation.js'
import { buildPlaybook } from '../src/teach-store.js'
import {
  appendLearnedRun,
  listLearnedRuns,
  normalizeRating,
} from '../src/learned-runs.js'

const home = mkdtempSync(join(tmpdir(), 'glance-runs-'))
after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('normalizeRating', () => {
  assert.equal(normalizeRating('好'), 'good')
  assert.equal(normalizeRating('一般'), 'ok')
  assert.equal(normalizeRating('差'), 'bad')
  assert.equal(normalizeRating('nope'), null)
})

test('append / list runs（旁证；评价链已移除）', async () => {
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
  assert.equal(listed[0].ok, true)
})
