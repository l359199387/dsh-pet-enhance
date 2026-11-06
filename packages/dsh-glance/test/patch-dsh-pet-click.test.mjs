import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  PATCH_MARK,
  applyDshPetClickPatches,
  inputJsPath,
  patchDesktopClickOpensChat,
} from '../src/patch-dsh-pet-click.js'

const SAMPLE = `
  onClick(e) {
    if (this.sleeping) {
      return;
    }
    // 点击音效与浏览器同位置：放在「按下已触发积分」的早退之后、点击动画判断之前
    playClickSound();
    if (!this.animations.clicks.length) return;
    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）
    this.playOnce(S.pick(this.animations.clicks));
  },
`

test('patchDesktopClickOpensChat：写入标记且幂等', () => {
  const once = patchDesktopClickOpensChat(SAMPLE)
  assert.equal(once.changed, true)
  assert.ok(once.text.includes(PATCH_MARK))
  assert.ok(once.text.includes('showChatFromMenu'))
  const twice = patchDesktopClickOpensChat(once.text)
  assert.equal(twice.changed, false)
  assert.equal(twice.reason, 'already-patched')
})

test('applyDshPetClickPatches：写盘并再跑不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'glance-pet-'))
  const file = inputJsPath(root)
  mkdirSync(join(root, 'runtime', 'electron-helper', 'sprite'), { recursive: true })
  writeFileSync(file, SAMPLE, 'utf8')

  const a = applyDshPetClickPatches({ roots: [root] })
  assert.equal(a.ok, true)
  assert.equal(a.results[0].changed, true)
  assert.ok(readFileSync(file, 'utf8').includes(PATCH_MARK))

  const b = applyDshPetClickPatches({ roots: [root] })
  assert.equal(b.results[0].changed, false)
  assert.equal(b.results[0].reason, 'already-patched')
})
