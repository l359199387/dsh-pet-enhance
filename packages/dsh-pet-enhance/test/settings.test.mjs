import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../src/settings.js'
import {
  glanceMenuLabels,
  MENU_ACT_OFF,
  MENU_ACT_ON,
  MENU_LIVE_OFF,
  MENU_LIVE_ON,
  MENU_STOP,
} from '../src/dsh-pet.js'

const home = mkdtempSync(join(tmpdir(), 'glance-set-'))
after(() => { rmSync(home, { recursive: true, force: true }) })

test('默认 liveWatch / actEnabled 关闭，locale 为 zh', async () => {
  const s = await loadSettings(home)
  assert.deepEqual(s, { ...DEFAULT_SETTINGS })
  assert.equal(s.locale, 'zh')
})

test('saveSettings 可读写 liveWatch 与 actEnabled 与 locale', async () => {
  const on = await saveSettings(home, { liveWatch: true, actEnabled: true, locale: 'en' })
  assert.equal(on.liveWatch, true)
  assert.equal(on.actEnabled, true)
  assert.equal(on.locale, 'en')
  assert.equal((await loadSettings(home)).actEnabled, true)
  assert.equal((await loadSettings(home)).locale, 'en')
  await saveSettings(home, { liveWatch: false, actEnabled: false, locale: 'zh' })
  assert.equal((await loadSettings(home)).liveWatch, false)
  assert.equal((await loadSettings(home)).locale, 'zh')
})

test('菜单文案：看屏 / 动手 / 急停（中英）', () => {
  assert.deepEqual(glanceMenuLabels(false, false, false, 'zh'), [MENU_LIVE_OFF, MENU_ACT_OFF, MENU_STOP])
  assert.deepEqual(glanceMenuLabels(true, true, false, 'zh'), [MENU_LIVE_ON, MENU_ACT_ON, MENU_STOP])
  assert.equal(glanceMenuLabels(false, false, true, 'zh').length, 5)
  const en = glanceMenuLabels(false, false, false, 'en')
  assert.equal(en.length, 3)
  assert.match(en[2], /Stop/i)
})
