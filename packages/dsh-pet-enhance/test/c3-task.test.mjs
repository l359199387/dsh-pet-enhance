/**
 * C3 端到端纪律与验收剧本。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  C3_ACCEPTANCE_GOAL,
  C3_MAX_ACTIONS,
  C3_STEP_RETRY,
  buildC3DisciplineBlock,
  c3AcceptanceChecklist,
  c3BudgetExceededBubble,
  c3MaybeNoopHint,
  isC3NotepadIntent,
} from '../src/c3-task.js'
import { actToolSpec } from '../src/tool-spec-act.js'
import { buildAgentWakePrompt, AGENT_WAKE_PREFIX } from '../src/agent-bridge.js'
import { buildSmartRunPrompt } from '../src/teach-smart.js'

test('isC3NotepadIntent：记事本闭环命中', () => {
  assert.equal(isC3NotepadIntent('打开记事本，写下今天的日期，保存到桌面，然后关掉'), true)
  assert.equal(isC3NotepadIntent('帮我用 notepad 写下日期并保存'), true)
  assert.equal(isC3NotepadIntent('打开记事本'), false)
  assert.equal(isC3NotepadIntent('今天吃什么'), false)
})

test('buildC3DisciplineBlock：禁 act，含重试', () => {
  const full = buildC3DisciplineBlock({ includeScenario: true })
  assert.match(full, /执行纪律·无鼠标键盘/)
  assert.match(full, /禁止.*act|禁止.*鼠标/)
  assert.match(full, new RegExp(String(C3_STEP_RETRY)))
  assert.ok(full.includes(C3_ACCEPTANCE_GOAL))

  const slim = buildC3DisciplineBlock({ includeScenario: false })
  assert.match(slim, /执行纪律·无鼠标键盘/)
  assert.ok(!slim.includes(C3_ACCEPTANCE_GOAL))
})

test('c3AcceptanceChecklist：四项门禁', () => {
  const list = c3AcceptanceChecklist()
  assert.equal(list.length, 4)
  assert.ok(list.every((x) => x.id && x.title && x.check))
})

test('提示气泡：maybeNoop / 预算', () => {
  assert.match(c3MaybeNoopHint(), /glance/)
  assert.match(c3MaybeNoopHint(), new RegExp(String(C3_STEP_RETRY)))
  assert.match(c3BudgetExceededBubble(), /新一轮/)
})

test('buildAgentWakePrompt：接入纪律；记事本口令加强', () => {
  const p = buildAgentWakePrompt('打开记事本写下今天日期保存到桌面再关掉')
  assert.ok(p.startsWith(AGENT_WAKE_PREFIX))
  assert.match(p, /执行纪律·无鼠标键盘/)
  assert.match(p, /脚本|写文件/)
  assert.ok(p.includes(C3_ACCEPTANCE_GOAL))
})

test('buildSmartRunPrompt / actToolSpec：含纪律块', () => {
  const smart = buildSmartRunPrompt({
    id: 'x',
    goal: '进B站',
    strategy: { fastPlan: '打开 bilibili', summary: '打开B站' },
  })
  assert.match(smart, /执行纪律·无鼠标键盘/)
  assert.ok(!smart.includes(C3_ACCEPTANCE_GOAL))

  const spec = actToolSpec()
  assert.match(spec.description, /执行纪律·无鼠标键盘/)
  assert.match(spec.description, /glance/)
})
