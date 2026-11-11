import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_LOCALE,
  menuLabelVariants,
  menuLabelsFor,
  normalizeLocale,
  t,
} from '../src/i18n.js'

test('normalizeLocale 默认中文', () => {
  assert.equal(normalizeLocale(''), DEFAULT_LOCALE)
  assert.equal(normalizeLocale('zh-CN'), 'zh')
  assert.equal(normalizeLocale('en-US'), 'en')
})

test('t 插值与回退', () => {
  assert.match(t('zh', 'bubble.greet'), /技能|电脑操控/)
  assert.match(t('en', 'bubble.greet'), /Mnemon|computer-use/i)
  assert.equal(t('zh', 'menu.stop'), '小蓝鲸急停')
})

test('菜单中英文变体都可命中', () => {
  const stops = menuLabelVariants('menu.stop')
  assert.ok(stops.includes('小蓝鲸急停'))
  assert.ok(stops.some((s) => /Stop/i.test(s)))
  assert.equal(menuLabelsFor('en', { liveWatch: true }).length, 3)
  assert.ok(menuLabelsFor('zh').includes('最近聊天内容'))
  assert.ok(!menuLabelsFor('zh').some((l) => /允许动手|Allow act/.test(l)))
  assert.ok(menuLabelVariants('menu.recentChat').includes('Recent chat'))
})
