import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildTeachUnderstandPrompt,
  createTeachBridge,
} from '../src/teach-bridge.js'
import { TEACH_FOLLOWUP_PREFIX, AGENT_WAKE_PREFIX } from '../src/intent.js'
import { saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-b-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('buildTeachUnderstandPrompt：理解证据而非盲重放，敏感用 secretRef', () => {
  const p = buildTeachUnderstandPrompt(
    '登录',
    [
      { action: 'click', x: 10, y: 20, window: '密码本' },
      { action: 'type', secretRef: 'step:1', window: '密码本' },
    ],
    'teach_abc',
  )
  assert.ok(p.startsWith(AGENT_WAKE_PREFIX))
  assert.ok(p.includes(TEACH_FOLLOWUP_PREFIX))
  assert.ok(p.includes('理解'))
  assert.ok(p.includes('secretRef=teach_abc/step:1'))
  assert.ok(!p.includes('secret!'))
  assert.ok(p.includes('坐标仅供参考') || p.includes('示意坐标'))
})

test('教完后叫醒主会话理解执行（含 secretRef 提示）', async () => {
  await saveSettings(home, { actEnabled: true })
  const wakes = []
  const queued = [
    { kind: 'click', x: 1, y: 2, button: 'left', window: { title: '记事本' } },
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
    wake: async (_ctx, { text }) => {
      wakes.push(text)
      return { ok: true, sessionId: 's1', via: 'followup' }
    },
    waitReply: async () => ({ ok: true, text: '好了，已经按理解做完。' }),
  })

  await bridge.startTeaching('我教你一下保存文件')
  assert.equal(bridge.isTeaching(), true)
  await bridge.stopAndRun()
  assert.equal(bridge.isTeaching(), false)
  assert.equal(wakes.length, 1)
  assert.ok(wakes[0].includes(TEACH_FOLLOWUP_PREFIX))
  assert.ok(wakes[0].includes('secretRef='))
  assert.ok(!wakes[0].includes('secret!'))
  assert.ok(wakes[0].includes('理解'))
  bridge.stop()
})
