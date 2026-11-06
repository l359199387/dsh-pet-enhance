import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hasExplicitScheduleIntent,
  parseClockTime,
  parseScheduleSpec,
  parseWeekdays,
  timingToCreateFields,
} from '../src/schedule-parse.js'

test('目标名「每日心情」不定时', () => {
  assert.equal(hasExplicitScheduleIntent('记录每日的心情'), false)
  assert.equal(parseScheduleSpec('记录每日的心情'), null)
  assert.equal(parseScheduleSpec('教我记一下每日心情'), null)
})

test('每天晚上九点 → daily', () => {
  assert.equal(hasExplicitScheduleIntent('每天晚上九点记录心情'), true)
  const s = parseScheduleSpec('每天晚上九点记录心情')
  assert.equal(s?.kind, 'daily')
  assert.equal(s?.time, '21:00:00.000')
  assert.match(s?.label || '', /每天/)
  assert.deepEqual(timingToCreateFields(s)?.timing?.kind, 'daily')
})

test('每周一三五上午10点 → weekly', () => {
  const s = parseScheduleSpec('每周一三五上午10点跑一遍')
  assert.equal(s?.kind, 'weekly')
  assert.deepEqual(s?.weekdays, [1, 3, 5])
  assert.equal(s?.time, '10:00:00.000')
})

test('工作日 / 解析时钟', () => {
  assert.deepEqual(parseWeekdays('工作日'), [1, 2, 3, 4, 5])
  assert.equal(parseClockTime('21:30'), '21:30:00.000')
  assert.equal(parseClockTime('下午3点半'), '15:30:00.000')
})

test('30分钟后 / 每2小时', () => {
  assert.equal(parseScheduleSpec('30分钟后提醒我')?.kind, 'after')
  assert.equal(parseScheduleSpec('每2小时检查一次')?.kind, 'every')
})
