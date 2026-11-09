import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCoachWakePrompt } from '../src/teach-coach.js'

test('buildCoachWakePrompt：由宿主已判定可执行，强调理解后只做本步', () => {
  const p = buildCoachWakePrompt('记录心情', '先打开记事本', { attemptCount: 2 })
  assert.match(p, /可执行的本步指示/)
  assert.match(p, /不要自行把总目标/)
  assert.match(p, /先打开记事本/)
  assert.doesNotMatch(p, /只做本步】/)
})
