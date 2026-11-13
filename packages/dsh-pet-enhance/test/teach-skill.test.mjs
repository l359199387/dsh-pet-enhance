import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildTeachSkillMarkdown,
  ensureUniqueSkillName,
  intentSlugFromText,
  normalizeSkillSlug,
  skillSlugFromGoal,
  writeTeachSkillFile,
} from '../src/teach-skill.js'
import { findSkillForQuery, listTeachSkills, parseSkillFrontmatter } from '../src/skill-match.js'

const root = mkdtempSync(join(tmpdir(), 'pe-skills-'))
after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('skillSlugFromGoal：语义名 / 中文意图 / pe-learn 回落', () => {
  assert.equal(skillSlugFromGoal('daily mood note', 'x'), 'daily-mood-note')
  assert.equal(normalizeSkillSlug('Chat Doubao!!'), 'chat-doubao')
  assert.equal(intentSlugFromText('和豆包姐姐聊天'), 'doubao-chat')
  assert.equal(skillSlugFromGoal('和豆包姐姐聊天', 'abc1234567890'), 'doubao-chat')
  assert.equal(skillSlugFromGoal('用极速浏览器看微博热搜', 'x'), 'weibo-hot-search-open')
  assert.match(skillSlugFromGoal('完成主人要教的这件事', 'abc1234567890'), /^pe-learn-/)
})

test('ensureUniqueSkillName：重名加后缀', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const a = ensureUniqueSkillName('doubao-chat')
    assert.equal(a, 'doubao-chat')
    mkdirSync(join(root, 'skills', 'doubao-chat'), { recursive: true })
    assert.equal(ensureUniqueSkillName('doubao-chat'), 'doubao-chat-2')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
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

test('占位 goal 落盘改用理解摘要；业务问答可匹配', async () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    await writeTeachSkillFile({
      goal: '完成主人要教的这件事',
      name: 'toyota-qa',
      summary: '教我用丰田二手车项目 ftms-ucar360-platform 的代码来回答业务问题，只看不改。',
      teachSessionId: 'sess-toyota',
    })
    const md = readFileSync(join(root, 'skills', 'toyota-qa', 'SKILL.md'), 'utf8')
    assert.match(md, /丰田二手车/)
    assert.doesNotMatch(md, /goal: "完成主人要教的这件事"/)
    const hit = await findSkillForQuery('丰田项目的精英零售出库的标准是什么?', {
      root: join(root, 'skills'),
      allowLegacyLearned: false,
    })
    assert.ok(hit)
    assert.equal(hit.name, 'toyota-qa')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})
