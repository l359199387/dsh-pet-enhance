import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildTeachDigestPrompt,
  createTeachBridge,
  parseTeachDigestReply,
} from '../src/teach-bridge.js'
import { AGENT_WAKE_PREFIX } from '../src/intent.js'
import { assertLearnedAutomationPair, listLearnedIndex } from '../src/learned-automation.js'
import { learnedFramesDir } from '../src/teach-frames.js'
import { saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-b-'))
after(() => rmSync(home, { recursive: true, force: true }))

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

test('parseTeachDigestReply：OK / NEED_MORE', () => {
  assert.equal(parseTeachDigestReply('NEED_MORE').needMore, true)
  assert.equal(parseTeachDigestReply('OK: 在记事本写心情').summary.includes('心情'), true)
  assert.ok(buildTeachDigestPrompt('g', 'n', 3).startsWith(AGENT_WAKE_PREFIX))
})

test('教完：关键帧落盘、理解后建对、关实时看屏幕、不自动动手', async () => {
  await saveSettings(home, { liveWatch: true, actEnabled: true })
  const acts = []
  const liveOps = []
  const wakes = []
  const queued = [
    { kind: 'key', keys: 'ctrl+s', window: { title: '记事本' } },
    { kind: 'type', text: 'hello', window: { title: '记事本' } },
  ]
  const schedules = []
  const prevDsh = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const bridge = createTeachBridge({
    home,
    ctx: {
      get(name) {
        if (name === 'schedule') {
          return {
            async create() { schedules.push(1); return { id: 'sched-1' } },
            async edit(spec) { schedules.push(spec); return {} },
          }
        }
        return null
      },
    },
    log() {},
    pollChat: false,
    capture: async () => ({ png: tinyPng, window: { title: '记事本' } }),
    ensureLiveWatch: async (on) => { liveOps.push(on) },
    attachments: {
      async saveImage() { return { id: 'att-1' } },
    },
    wake: async (_ctx, opts) => {
      wakes.push({ images: opts.images?.length || 0, text: opts.text })
      return { ok: true, sessionId: 's1' }
    },
    waitReply: async () => ({ ok: true, text: 'OK: 保存记事本里的内容' }),
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
  })

  try {
    await bridge.startTeaching('我教你一下保存文件')
    await bridge.stopAndRun()
    assert.equal(acts.length, 0)
    assert.ok(wakes.some((w) => w.images >= 1), '理解时应喂关键帧')
    assert.ok(liveOps.includes(false), '学完应关实时看屏幕')
    const idx = await listLearnedIndex(home)
    assert.equal(idx.length, 1)
    const pair = await assertLearnedAutomationPair(home, idx[0].id)
    assert.equal(pair.ok, true)
    assert.ok(existsSync(join(learnedFramesDir(home, idx[0].id), 'manifest.json')))
    assert.ok(pair.learn.frames?.forLearningOnly)
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    bridge.stop()
  }
})
