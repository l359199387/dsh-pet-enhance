/**
 * 确认可见性：文案 / 菜单标签 / 挂起回调契约。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConfirmGate } from '../src/confirm.js'
import { menuLabelsFor, t } from '../src/i18n.js'

test('pending 时菜单含「好 / 不要」', () => {
  const off = menuLabelsFor('zh', { pendingConfirm: false })
  assert.ok(!off.some((x) => /确认动作/.test(x)))

  const on = menuLabelsFor('zh', { pendingConfirm: true })
  assert.ok(on.includes(t('zh', 'menu.confirmYes')))
  assert.ok(on.includes(t('zh', 'menu.confirmNo')))
})

test('确认挂起回调收到摘要；清除时回 null', async () => {
  const seen = []
  const gate = createConfirmGate({
    timeoutMs: 5_000,
    onPending: (p) => seen.push(p),
  })
  const p = gate.ask({ summary: '按键 ctrl+s — 保存到桌面', tier: 'L2' })
  assert.equal(seen.length, 1)
  assert.match(seen[0].summary, /ctrl\+s/)
  assert.ok(seen[0].id)

  const bubble = t('zh', 'bubble.confirmAsk', { summary: seen[0].summary })
  assert.match(bubble, /需要你确认/)
  assert.match(bubble, /头顶/)

  gate.resolve(seen[0].id, true)
  await p
  assert.equal(seen.at(-1), null)
})

test('任务接手文案', () => {
  assert.match(t('zh', 'bubble.taskTakeover'), /这事我来办/)
  assert.match(t('zh', 'bubble.taskTakeover'), /电脑操控|windows_computer_use_/)
})
