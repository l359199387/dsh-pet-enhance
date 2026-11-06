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
  assert.equal(t('zh', 'learned.count', { n: 2 }), '2 条')
  assert.equal(t('en', 'learned.count', { n: 2 }), '2 items')
  assert.equal(t('zh', 'menu.stop'), '小蓝鲸急停')
})

test('菜单中英文变体都可命中', () => {
  const stops = menuLabelVariants('menu.stop')
  assert.ok(stops.includes('小蓝鲸急停'))
  assert.ok(stops.some((s) => /Stop/i.test(s)))
  assert.equal(menuLabelsFor('en', { liveWatch: true, actEnabled: false }).length, 3)
})
