import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createTeachBridge } from '../src/teach-bridge.js'
import { loadSettings, saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-live-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('未开实时看屏幕：提示且不开课（无确认闸）', async () => {
  await saveSettings(home, { liveWatch: false, actEnabled: true })
  let started = false
  const bridge = createTeachBridge({
    home,
    log() {},
    pollChat: false,
    sidecar: {
      isAlive: () => true,
      async call() {
        started = true
        return { ok: true, events: [] }
      },
    },
  })
  await bridge.startTeaching('我教你一下保存')
  assert.equal(bridge.isTeaching(), false)
  assert.equal(started, false)
  bridge.stop()
})

test('确认后打开实时看屏幕再开课', async () => {
  await saveSettings(home, { liveWatch: false, actEnabled: true })
  const ensures = []
  const bridge = createTeachBridge({
    home,
    log() {},
    pollChat: false,
    confirmGate: {
      async ask() { return { allow: true, via: 'user-allow', id: '1' } },
    },
    ensureLiveWatch: async (on) => {
      ensures.push(on)
      await saveSettings(home, { liveWatch: on })
    },
    sidecar: {
      isAlive: () => true,
      async call(op, fields) {
        if (fields?.action === 'start') return { ok: true, running: true, events: [] }
        return { ok: true, events: [] }
      },
    },
  })
  await bridge.startTeaching('教你保存')
  assert.deepEqual(ensures, [true])
  assert.equal(bridge.isTeaching(), true)
  assert.equal((await loadSettings(home)).liveWatch, true)
  bridge.stop()
})

test('已开实时看屏幕：直接开课', async () => {
  await saveSettings(home, { liveWatch: true, actEnabled: true })
  const bridge = createTeachBridge({
    home,
    log() {},
    pollChat: false,
    sidecar: {
      isAlive: () => true,
      async call(op, fields) {
        if (fields?.action === 'start') return { ok: true, running: true, events: [] }
        return { ok: true, events: [] }
      },
    },
  })
  await bridge.startTeaching('教你保存')
  assert.equal(bridge.isTeaching(), true)
  bridge.stop()
})
