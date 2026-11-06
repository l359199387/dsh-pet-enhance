import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildHarnessAutomationPrompt,
  DEFAULT_AFTER_SECONDS,
  registerHarnessAutomation,
  skillSlugFromId,
} from '../src/harness-schedule.js'

const home = mkdtempSync(join(tmpdir(), 'glance-hs-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('skillSlug 为 kebab-case', () => {
  assert.match(skillSlugFromId('20261107-014933-4caa90ac'), /^glance-learn-[a-z0-9]+$/)
})

test('prompt：点击靠 glance；文字步骤可复打', () => {
  const p = buildHarnessAutomationPrompt({
    goal: '记录心情',
    learnedId: 'x',
    skillName: 'glance-learn-x',
  })
  assert.ok(p.includes('不要加载'))
  assert.ok(p.includes('glance'))
  assert.ok(p.includes('用户键入文字') || p.includes('text'))
})

test('registerHarnessAutomation：create(sessionId, request) 且用 after_seconds', async () => {
  process.env.DSH_HOME = home
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'schedule') {
        return {
          async create(sessionId, request) {
            calls.push({ sessionId, request })
            return { id: 'schedule-abc', title: request.title, kind: 'after' }
          },
        }
      }
      if (name === 'sessions') {
        return { list: () => [{ id: 'sess-1', focused: true }] }
      }
      return null
    },
  }
  const r = await registerHarnessAutomation(ctx, {
    goal: '记录每日的心情',
    learnedId: '20261107-014933-4caa90ac',
    automationId: '20261107-014933-4caa90ac',
    summary: 'demo',
    preferredSessionId: 'sess-preferred',
    log() {},
  })
  assert.equal(r.ok, true)
  assert.equal(r.scheduleId, 'schedule-abc')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'sess-preferred')
  assert.equal(calls[0].request.title, '记录每日的心情')
  assert.equal(calls[0].request.after_seconds, DEFAULT_AFTER_SECONDS)
  assert.equal(calls[0].request.timing, undefined)
  const skillPath = join(home, 'skills', r.skillName, 'SKILL.md')
  assert.ok(readFileSync(skillPath, 'utf8').includes('记录每日的心情'))
})

test('无会话时明确失败', async () => {
  process.env.DSH_HOME = home
  const r = await registerHarnessAutomation({
    get(name) {
      if (name === 'schedule') return { async create() { return { id: 'x' } } }
      return null
    },
  }, {
    goal: 'x',
    learnedId: 'id1',
    automationId: 'id1',
    summary: '',
    preferredSessionId: null,
    log() {},
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-session-for-schedule')
})
