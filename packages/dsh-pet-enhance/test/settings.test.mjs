import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadSettings, saveSettings, isActEnabled, DEFAULT_SETTINGS } from '../src/settings.js'
import {
  glanceMenuLabels,
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

test('saveSettings：actEnabled 写入被忽略恒 false；liveWatch/locale 可读写', async () => {
  const on = await saveSettings(home, { liveWatch: true, actEnabled: true, locale: 'en' })
  assert.equal(on.liveWatch, true)
  assert.equal(on.actEnabled, false)
  assert.equal(on.locale, 'en')
  assert.equal(isActEnabled(home), false)
  assert.equal((await loadSettings(home)).locale, 'en')
  await saveSettings(home, { liveWatch: false, actEnabled: false, locale: 'zh' })
  assert.equal((await loadSettings(home)).liveWatch, false)
  assert.equal((await loadSettings(home)).locale, 'zh')
})

test('菜单文案：看屏 / 最近聊天 / 急停（无允许动手）', () => {
  const zh = glanceMenuLabels(false, false, false, 'zh')
  assert.equal(zh[0], MENU_LIVE_OFF)
  assert.match(zh[1], /最近聊天/)
  assert.equal(zh[2], MENU_STOP)
  assert.equal(zh.length, 3)
  assert.deepEqual(
    glanceMenuLabels(true, true, false, 'zh').slice(0, 1),
    [MENU_LIVE_ON],
  )
  assert.equal(glanceMenuLabels(false, false, true, 'zh').length, 5)
  const en = glanceMenuLabels(false, false, false, 'en')
  assert.equal(en.length, 3)
  assert.match(en[2], /Stop/i)
})
