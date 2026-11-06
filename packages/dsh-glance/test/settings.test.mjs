import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../src/settings.js'
import { glanceMenuLabels, MENU_LIVE_OFF, MENU_LIVE_ON, MENU_STOP } from '../src/dsh-pet.js'

const home = mkdtempSync(join(tmpdir(), 'glance-set-'))
after(() => { rmSync(home, { recursive: true, force: true }) })

test('默认 liveWatch / actEnabled 关闭', async () => {
  const s = await loadSettings(home)
  assert.deepEqual(s, { ...DEFAULT_SETTINGS })
})

test('saveSettings 可读写 liveWatch 与 actEnabled', async () => {
  const on = await saveSettings(home, { liveWatch: true, actEnabled: true })
  assert.equal(on.liveWatch, true)
  assert.equal(on.actEnabled, true)
  assert.equal((await loadSettings(home)).actEnabled, true)
  await saveSettings(home, { liveWatch: false, actEnabled: false })
  assert.equal((await loadSettings(home)).liveWatch, false)
})

test('菜单文案：开关两态 + 急停', () => {
  assert.deepEqual(glanceMenuLabels(false), [MENU_LIVE_OFF, MENU_STOP])
  assert.deepEqual(glanceMenuLabels(true), [MENU_LIVE_ON, MENU_STOP])
})
