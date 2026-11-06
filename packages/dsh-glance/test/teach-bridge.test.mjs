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
})

test('教完：建学习对但不自动动手（防胡乱打字）', async () => {
  await saveSettings(home, { liveWatch: true, actEnabled: true })
  const acts = []
  const wakes = []
  const queued = [
    { kind: 'key', keys: 'ctrl+s', window: { title: '记事本' } },
    { kind: 'type', text: 'hello-should-not-type', window: { title: '记事本' } },
  ]
  const schedules = []
  const bridge = createTeachBridge({
    home,
    ctx: {
      get(name) {
        if (name === 'schedule') {
          return {
            async create(spec) {
              schedules.push(spec)
              return { id: 'sched-1' }
            },
            async edit(spec) {
              schedules.push({ edit: spec })
              return { ok: true }
            },
          }
        }
        return null
      },
    },
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
      return { ok: true, sessionId: 's1' }
    },
    waitReply: async () => ({ ok: true, text: 'no' }),
  })

  const prevDsh = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await bridge.startTeaching('我教你一下保存文件')
    await bridge.stopAndRun()
    assert.equal(bridge.isTeaching(), false)
    assert.equal(acts.length, 0, '教完不得自动 act')
    assert.equal(wakes.length, 0, '教完不得自动叫醒动手')
    assert.ok(schedules.length >= 1, '应登记 Harness schedule')
    const idx = await listLearnedIndex(home)
    assert.equal(idx.length, 1)
    const pair = await assertLearnedAutomationPair(home, idx[0].id)
    assert.equal(pair.ok, true)
    assert.ok(pair.playbook.steps.some((s) => s.mode === 'glance' && s.action === 'type'))
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    bridge.stop()
  }
})
