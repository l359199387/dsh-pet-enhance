import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createTeachBridge } from '../src/teach-bridge.js'
import { saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-b-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('教完后按步骤本地回放（含 secretRef）', async () => {
  await saveSettings(home, { actEnabled: true })
  const bubbles = []
  const acts = []
  const queued = [
    { kind: 'click', x: 1, y: 2, button: 'left', window: { title: '记事本' } },
    { kind: 'type', text: 'secret!', sensitive: true, window: { title: '密码本' } },
  ]
  const bridge = createTeachBridge({
    home,
    log() {},
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

  await bridge.startTeaching('我教你一下保存文件')
  assert.equal(bridge.isTeaching(), true)
  await bridge.stopAndRun()
  assert.equal(bridge.isTeaching(), false)
  assert.ok(acts.length >= 2)
  assert.equal(acts[0].action, 'click')
  assert.equal(acts[0]._teachReplay, true)
  assert.equal(acts[1].action, 'type')
  assert.ok(String(acts[1].secretRef).includes('step:'))
  assert.equal(acts[1].text, undefined)
  void bubbles
  bridge.stop()
})
