import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createTeachBridge } from '../src/teach-bridge.js'
import { saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-live-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('对话带教：不要求允许动手即可开课', async () => {
  await saveSettings(home, { liveWatch: false, actEnabled: false })
  const bridge = createTeachBridge({
    home,
    log() {},
    pollChat: false,
    ctx: { get: () => null },
    getPreferredSessionId: () => 's1',
    prepareSession: async () => ({ sessionId: 's1', fresh: true }),
    wake: async () => ({ ok: true, sessionId: 's1' }),
    waitReply: async () => ({ ok: true, text: '先试着做' }),
  })
  await bridge.startTeaching('我教你一下保存')
  assert.equal(bridge.isTeaching(), true)
  bridge.stop()
})

test('对话带教：不要求实时看屏幕即可开课', async () => {
  await saveSettings(home, { liveWatch: false, actEnabled: true })
  const bridge = createTeachBridge({
    home,
    log() {},
    pollChat: false,
    ctx: { get: () => null },
    getPreferredSessionId: () => 's1',
    prepareSession: async () => ({ sessionId: 's1', fresh: true }),
    wake: async () => ({ ok: true, sessionId: 's1' }),
    waitReply: async () => ({ ok: true, text: '先试着做' }),
  })
  await bridge.startTeaching('教你保存')
  assert.equal(bridge.isTeaching(), true)
  bridge.stop()
})
