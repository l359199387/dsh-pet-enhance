import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  OLD_CLICK_PATCH_MARK,
  PATCH_MARK,
  applyDshPetClickPatches,
  initJsPath,
  inputJsPath,
  patchDesktopDblClickOpensChat,
  stripOldClickOpensChat,
} from '../src/patch-dsh-pet-click.js'

const SAMPLE_INPUT_OLD = `
  onClick(e) {
    playClickSound();
    // ${OLD_CLICK_PATCH_MARK} — 单击打开原生对话（同右键「对话」）
    if (typeof this.showChatFromMenu === 'function') {
      this.showChatFromMenu();
      return;
    }
    if (!this.animations.clicks.length) return;
    this.pendingSquash = true;
    this.playOnce(S.pick(this.animations.clicks));
  },
`

const SAMPLE_INIT = `
  bindEvents() {
    const ac = new AbortController();
    this.ac = ac;
    this.hit.addEventListener('click', (e) => this.onClick(e), { signal: ac.signal });
    this.hit.addEventListener('contextmenu', (e) => this.onContextMenu(e), { signal: ac.signal });
  }
`

test('stripOldClickOpensChat：剥掉旧单击块且幂等', () => {
  const once = stripOldClickOpensChat(SAMPLE_INPUT_OLD)
  assert.equal(once.changed, true)
  assert.ok(!once.text.includes(OLD_CLICK_PATCH_MARK))
  assert.ok(!once.text.includes('showChatFromMenu'))
  assert.ok(once.text.includes('playClickSound'))
  const twice = stripOldClickOpensChat(once.text)
  assert.equal(twice.changed, false)
  assert.equal(twice.reason, 'no-old-patch')
})

test('patchDesktopDblClickOpensChat：写入标记且幂等', () => {
  const once = patchDesktopDblClickOpensChat(SAMPLE_INIT)
  assert.equal(once.changed, true)
  assert.ok(once.text.includes(PATCH_MARK))
  assert.ok(once.text.includes('dblclick'))
  assert.ok(once.text.includes('showChatFromMenu'))
  const twice = patchDesktopDblClickOpensChat(once.text)
  assert.equal(twice.changed, false)
  assert.equal(twice.reason, 'already-patched')
})

test('applyDshPetClickPatches：剥旧单击 + 写双击，再跑不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'glance-pet-'))
  const inputFile = inputJsPath(root)
  const initFile = initJsPath(root)
  mkdirSync(join(root, 'runtime', 'electron-helper', 'sprite'), { recursive: true })
  writeFileSync(inputFile, SAMPLE_INPUT_OLD, 'utf8')
  writeFileSync(initFile, SAMPLE_INIT, 'utf8')

  const a = applyDshPetClickPatches({ roots: [root] })
  assert.equal(a.ok, true)
  assert.ok(a.results.some((r) => r.changed && r.reason === 'stripped-old-click'))
  assert.ok(a.results.some((r) => r.changed && r.reason === 'patched'))
  assert.ok(!readFileSync(inputFile, 'utf8').includes(OLD_CLICK_PATCH_MARK))
  assert.ok(readFileSync(initFile, 'utf8').includes(PATCH_MARK))

  const b = applyDshPetClickPatches({ roots: [root] })
  assert.equal(b.results.every((r) => !r.changed || r.reason === 'already-patched' || r.reason === 'missing'), true)
  assert.ok(b.results.some((r) => r.reason === 'already-patched'))
})
