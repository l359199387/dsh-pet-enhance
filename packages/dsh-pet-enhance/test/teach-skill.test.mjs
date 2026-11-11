import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildTeachSkillMarkdown,
  skillSlugFromGoal,
  writeTeachSkillFile,
} from '../src/teach-skill.js'
import { findSkillForQuery, listTeachSkills, parseSkillFrontmatter } from '../src/skill-match.js'

const root = mkdtempSync(join(tmpdir(), 'pe-skills-'))
after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('skillSlugFromGoal：语义名或 pe-learn 回落', () => {
  assert.equal(skillSlugFromGoal('daily mood note', 'x'), 'daily-mood-note')
  assert.match(skillSlugFromGoal('记录每日心情', 'abc1234567890'), /^pe-learn-/)
})

test('writeTeachSkillFile + findSkillForQuery', async () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const written = await writeTeachSkillFile({
      goal: '记录每日心情',
      name: 'daily-mood-note',
      summary: '写到桌面日记',
      fastPlan: '写文件',
      teachSessionId: 'sess1',
      aliases: ['心情'],
    })
    assert.equal(written.name, 'daily-mood-note')
    const md = readFileSync(join(root, 'skills', 'daily-mood-note', 'SKILL.md'), 'utf8')
    assert.match(md, /status: verified/)
    assert.match(md, /source: pet-teach/)
    assert.match(md, /windows_computer_use_/)

    const list = await listTeachSkills(join(root, 'skills'))
    assert.equal(list.length, 1)
    assert.equal(list[0].goal.includes('心情'), true)

    const hit = await findSkillForQuery('执行一下记录每日心情', {
      root: join(root, 'skills'),
      allowLegacyLearned: false,
    })
    assert.ok(hit)
    assert.equal(hit.name, 'daily-mood-note')

    await writeTeachSkillFile({
      goal: '和豆包聊天',
      name: 'chat-doubao',
      summary: '闲聊',
      teachSessionId: 'sess2',
    })
    const softHit = await findSkillForQuery('和豆包姐姐聊聊天,沟通3轮', {
      root: join(root, 'skills'),
      allowLegacyLearned: false,
    })
    assert.ok(softHit)
    assert.equal(softHit.name, 'chat-doubao')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('parseSkillFrontmatter', () => {
  const raw = buildTeachSkillMarkdown({
    name: 'x',
    goal: '打开B站',
    summary: '开网页',
    aliases: ['b站'],
  })
  const { meta, body } = parseSkillFrontmatter(raw)
  assert.equal(meta.name, 'x')
  assert.equal(meta.status, 'verified')
  assert.match(body, /理解摘要/)
})
