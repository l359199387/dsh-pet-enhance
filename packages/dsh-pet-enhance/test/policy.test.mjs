import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_ACTIONS_PER_TURN,
  classifyAction,
  classifyKeys,
  createActionBudget,
  evaluateActPolicy,
  isDeniedWindow,
  summarizeActForConfirm,
  validateActionCoords,
} from '../src/policy.js'

test('黑名单窗口：密码管理器/银行/UAC/密码本', () => {
  assert.equal(isDeniedWindow('1Password'), true)
  assert.equal(isDeniedWindow('Bitwarden - Vault'), true)
  assert.equal(isDeniedWindow('我的密码本.txt - 记事本'), true)
  assert.equal(isDeniedWindow('中国银行网银'), true)
  assert.equal(isDeniedWindow('用户账户控制'), true)
  assert.equal(isDeniedWindow('记事本'), false)
})

test('黑名单：前台是桌宠时仍看点下方窗标题', () => {
  const r = evaluateActPolicy({
    args: { action: 'click', x: 10, y: 10, reason: '点一下' },
    windowTitles: ['dsh-pet 桌宠（桌面模式）', '密码本.txt - 记事本'],
    screen: { w: 1920, h: 1080 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DENIED_WINDOW')
  assert.match(r.windowTitle, /密码本/)
  assert.match(r.reason, /黑名单/)
  assert.match(r.userBubble, /黑名单/)
})

test('分级：观察 / 可逆 / 提交 / 危险 / 禁止', () => {
  assert.equal(classifyAction({ action: 'screen' }), 'L0')
  assert.equal(classifyAction({ action: 'move', x: 1, y: 2 }), 'L1')
  assert.equal(classifyAction({ action: 'click', x: 1, y: 2, reason: '点空白' }), 'L1')
  assert.equal(classifyAction({ action: 'click', x: 1, y: 2, reason: '点保存' }), 'L2')
  assert.equal(classifyKeys('win+r'), 'L3')
  assert.equal(classifyAction({ action: 'key', keys: 'win+r' }), 'L3')
  assert.equal(classifyAction({ action: 'key', keys: 'win+l' }), 'F')
  assert.equal(classifyAction({ action: 'type', text: '偷凭据', reason: '窃取凭据' }), 'F')
})

test('坐标越界拒绝', () => {
  const r = validateActionCoords(
    { action: 'click', x: 3000, y: 10 },
    { w: 1920, h: 1080 },
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'COORDS_OUT_OF_SCREEN')
})

test('预算超过上限拒绝', () => {
  const budget = createActionBudget({ max: MAX_ACTIONS_PER_TURN })
  for (let i = 0; i < MAX_ACTIONS_PER_TURN; i += 1) {
    assert.equal(evaluateActPolicy({
      args: { action: 'move', x: 1, y: 1 },
      budget,
      turnKey: 't1',
    }).ok, true)
  }
  const over = evaluateActPolicy({
    args: { action: 'move', x: 1, y: 1 },
    budget,
    turnKey: 't1',
  })
  assert.equal(over.ok, false)
  assert.equal(over.code, 'BUDGET_EXCEEDED')
})

test('黑名单窗 + 点击 → DENIED_WINDOW', () => {
  const r = evaluateActPolicy({
    args: { action: 'click', x: 10, y: 10, reason: '随便点' },
    windowTitle: 'KeePassXC',
    screen: { w: 1920, h: 1080 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DENIED_WINDOW')
})

test('L2 需要确认；摘要含具体坐标', () => {
  const r = evaluateActPolicy({
    args: { action: 'click', x: 1204, y: 688, reason: '点保存' },
    windowTitle: '记事本',
    screen: { w: 2560, h: 1440 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.needsConfirm, true)
  assert.equal(r.tier, 'L2')
  assert.match(summarizeActForConfirm({ action: 'click', x: 1204, y: 688, reason: '点保存' }, 'L2'), /1204/)
})
