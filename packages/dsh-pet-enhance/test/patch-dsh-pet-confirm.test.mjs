import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  ACT_SHIELD_PATCH_MARK,
  CONFIRM_PATCH_MARK,
  CONFIRM_SCRIPT_NAME,
  applyDshPetConfirmPatches,
  buildGlanceConfirmScript,
} from '../src/patch-dsh-pet-confirm.js'

const root = mkdtempSync(join(tmpdir(), 'glance-confirm-'))
after(() => rmSync(root, { recursive: true, force: true }))

test('buildGlanceConfirmScript 含标记与 token', () => {
  const s = buildGlanceConfirmScript('abc123token')
  assert.ok(s.includes(CONFIRM_PATCH_MARK))
  assert.ok(s.includes('abc123token'))
  assert.ok(s.includes('/api/pet-enhance'))
})

test('applyDshPetConfirmPatches 写入脚本并改 html/input/renderer', () => {
  const helper = join(root, 'runtime', 'electron-helper')
  const sprite = join(helper, 'sprite')
  mkdirSync(sprite, { recursive: true })
  writeFileSync(join(helper, 'index.html'), [
    '    <script src="./sprite/menu.js"></script>',
    '    <script src="./events.js"></script>',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(sprite, 'input.js'), [
    '  inputBusy() {',
    '    // 可点的气泡（余额翻页、工作气泡跳会话）同样是来源：它们长在窗口里、靠窗口级 click 触发，',
    '    // 却悬在平时穿透的余量区，正需要借 busy + 控件矩形把它们圈出来。',
    '    return (',
    '      this.dragState.active ||',
    '      this.menuOpen ||',
    '      this.chatOpen ||',
    '      this.todoOpen ||',
    '      this.balanceClickable() ||',
    '      this.workClickable()',
    '    );',
    '  },',
    "      ...document.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat, .dsh-pet-todo, .pet-bubble.is-clickable'),",
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(helper, 'renderer.js'), [
    '    sprites = [new PetSprite(pet)];',
    '    window.__dshPetDebug.configOk = true;',
    '',
  ].join('\n'), 'utf8')
  mkdirSync(join(helper, 'main'), { recursive: true })
  writeFileSync(join(helper, 'main', 'windows.js'), [
    '    const pointerTimer = setInterval(() => {',
    '      if (pointerFallbackPaused || win.isDestroyed()) return;',
    '      const bounds = win.getBounds();',
    '    }, POINTER_POLL_MS);',
    '',
  ].join('\n'), 'utf8')

  const a = applyDshPetConfirmPatches({ roots: [root], token: 'tokentokentoken12' })
  assert.equal(a.ok, true)
  assert.ok(a.results.some((r) => r.changed))
  const script = readFileSync(join(sprite, CONFIRM_SCRIPT_NAME), 'utf8')
  assert.ok(script.includes('tokentokentoken12'))
  assert.ok(script.includes("petState === 'acting'"))
  assert.ok(readFileSync(join(helper, 'index.html'), 'utf8').includes(CONFIRM_SCRIPT_NAME))
  assert.ok(readFileSync(join(sprite, 'input.js'), 'utf8').includes('_glanceConfirmOn'))
  assert.ok(readFileSync(join(helper, 'renderer.js'), 'utf8').includes('__dshGlanceSprites'))
  assert.ok(readFileSync(join(helper, 'main', 'windows.js'), 'utf8').includes(ACT_SHIELD_PATCH_MARK))
  assert.ok(readFileSync(join(helper, 'main', 'windows.js'), 'utf8').includes('desktop-act.lock'))

  const b = applyDshPetConfirmPatches({ roots: [root], token: 'tokentokentoken12' })
  assert.ok(b.results.every((r) => !r.changed || r.reason === 'unchanged' || r.reason === 'already-patched'))
})
