import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildHarnessAutomationPrompt,
  registerHarnessAutomation,
  skillSlugFromId,
  writeGlanceSkillFile,
} from '../src/harness-schedule.js'

const home = mkdtempSync(join(tmpdir(), 'glance-hs-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('skillSlug 为 kebab-case', () => {
  assert.match(skillSlugFromId('20261107-014933-4caa90ac'), /^glance-learn-[a-z0-9]+$/)
})

test('prompt 禁止盲打字指引', () => {
  const p = buildHarnessAutomationPrompt({
    goal: '记录心情',
    learnedId: 'x',
    skillName: 'glance-learn-x',
  })
  assert.ok(p.includes('禁止盲'))
  assert.ok(p.includes('glance'))
})

test('registerHarnessAutomation：写 skill + schedule.create 后暂停', async () => {
  process.env.DSH_HOME = home
  const edits = []
  const ctx = {
    get(name) {
      if (name !== 'schedule') return null
      return {
        async create() { return { id: 'task-abc' } },
        async edit(spec) { edits.push(spec); return {} },
      }
    },
  }
  const r = await registerHarnessAutomation(ctx, {
    goal: '记录每日的心情',
    learnedId: '20261107-014933-4caa90ac',
    automationId: '20261107-014933-4caa90ac',
    summary: 'demo',
    log() {},
  })
  assert.equal(r.ok, true)
  assert.equal(r.scheduleId, 'task-abc')
  assert.ok(edits.some((e) => e.active === false || e.patch?.active === false))
  const skillPath = join(home, 'skills', r.skillName, 'SKILL.md')
  const body = readFileSync(skillPath, 'utf8')
  assert.ok(body.includes('name:'))
  assert.ok(body.includes('记录每日的心情'))
})
