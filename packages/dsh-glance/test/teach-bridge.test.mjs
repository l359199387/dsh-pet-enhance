import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildTeachGlancePrompt,
  createTeachBridge,
} from '../src/teach-bridge.js'
import { TEACH_FOLLOWUP_PREFIX, AGENT_WAKE_PREFIX } from '../src/intent.js'
import { assertLearnedAutomationPair, listLearnedIndex } from '../src/learned-automation.js'
import { saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-b-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('buildTeachGlancePrompt：短提示只含 glance 线索', () => {
  const p = buildTeachGlancePrompt({
    id: 'teach_x',
    goal: '保存',
    steps: [
      { i: 0, mode: 'script', action: 'key', keys: 'ctrl+s' },
      { i: 1, mode: 'glance', action: 'click', window: '记事本', hint: { x: 1, y: 2 } },
    ],
  })
  assert.ok(p.startsWith(AGENT_WAKE_PREFIX))
  assert.ok(p.includes(TEACH_FOLLOWUP_PREFIX))
  assert.ok(p.includes('glance'))
  assert.ok(p.includes('记事本'))
})

test('教完：理解后建 learned↔automation，纯脚本不叫醒', async () => {
  await saveSettings(home, { liveWatch: true, actEnabled: true })
  const wakes = []
  const acts = []
  const queued = [
    { kind: 'key', keys: 'ctrl+s', window: { title: '记事本' } },
    { kind: 'type', text: 'hello', window: { title: '记事本' } },
  ]
  const bridge = createTeachBridge({
    home,
    ctx: {},
    log() {},
    pollChat: false,
    sidecar: {
      isAlive: () => true,
      async call(op, fields) {
        if (op !== 'observe') return { ok: false }
        if (fields.action === 'start') return { ok: true, running: true, events: [] }
        if (fields.action === 'poll') {
          const batch = queued.splice(0, queued.length)
          return { ok: true, running: true, events: batch }
        }
        if (fields.action === 'stop') return { ok: true, running: false, events: [] }
        return { ok: true, events: [] }
      },
    },
    runAct: async (args) => {
      acts.push(args)
      return { text: 'ok', meta: { ok: true } }
    },
    wake: async (_ctx, { text }) => {
      wakes.push(text)
      return { ok: true, sessionId: 's1', via: 'followup' }
    },
    waitReply: async () => ({ ok: true, text: '不应到这里' }),
  })

  await bridge.startTeaching('我教你一下保存文件')
  await bridge.stopAndRun()
  assert.equal(bridge.isTeaching(), false)
  assert.equal(wakes.length, 0)
  assert.ok(acts.length >= 2)
  const idx = await listLearnedIndex(home)
  assert.equal(idx.length, 1)
  const pair = await assertLearnedAutomationPair(home, idx[0].id)
  assert.equal(pair.ok, true)
  assert.equal(pair.playbook.stats.script, 2)
  bridge.stop()
})

test('含 click：问清后建对，再脚本+glance', async () => {
  await saveSettings(home, { liveWatch: true, actEnabled: true })
  const wakes = []
  const acts = []
  const queued = [
    { kind: 'click', x: 9, y: 8, button: 'left', window: { title: '记事本' } },
    { kind: 'type', text: 'secret!', sensitive: true, window: { title: '密码本' } },
  ]
  const bridge = createTeachBridge({
    home,
    ctx: {},
    log() {},
    pollChat: false,
    sidecar: {
      isAlive: () => true,
      async call(op, fields) {
        if (op !== 'observe') return { ok: false }
        if (fields.action === 'start') return { ok: true, running: true, events: [] }
        if (fields.action === 'poll') {
          const batch = queued.splice(0, queued.length)
          return { ok: true, running: true, events: batch }
        }
        if (fields.action === 'stop') return { ok: true, running: false, events: [] }
        return { ok: true, events: [] }
      },
    },
    runAct: async (args) => {
      acts.push(args)
      return { text: 'ok', meta: { ok: true } }
    },
    wake: async (_ctx, { text }) => {
      wakes.push(text)
      return { ok: true, sessionId: 's1', via: 'followup' }
    },
    waitReply: async () => ({ ok: true, text: '看屏步好了' }),
  })

  await bridge.startTeaching('教你登录')
  await bridge.stopAndRun()
  assert.equal(wakes.length, 1)
  assert.ok(!wakes[0].includes('secret!'))
  const idx = await listLearnedIndex(home)
  assert.ok(idx.length >= 1)
  const latest = idx[0]
  const pair = await assertLearnedAutomationPair(home, latest.id)
  assert.equal(pair.ok, true)
  assert.equal(pair.learn.automationId, pair.task.id)
  bridge.stop()
})
