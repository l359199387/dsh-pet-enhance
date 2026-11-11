import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { asToolOutput, createActTool } from '../src/tool-act.js'
import { saveSettings } from '../src/settings.js'
import { createConfirmGate } from '../src/confirm.js'
import { createActionBudget } from '../src/policy.js'
import { actionsFilePath } from '../src/audit.js'

function assertLosslessJson(value) {
  const again = JSON.parse(JSON.stringify(value))
  assert.deepEqual(again, value)
}

const home = mkdtempSync(join(tmpdir(), 'glance-act-'))
after(() => {
  delete process.env.DSH_PET_ENHANCE_ACT
  rmSync(home, { recursive: true, force: true })
})

function mockSidecar(handlers = {}) {
  return {
    isAlive: () => true,
    getHello: () => ({ screen: { w: 1920, h: 1080 } }),
    async call(op, fields) {
      if (handlers[op]) return handlers[op](fields)
      if (op === 'stats') {
        return {
          ok: true,
          active: { title: '记事本' },
          atPoint: { title: '记事本' },
          screen: { w: 1920, h: 1080 },
        }
      }
      if (op === 'capture') {
        return { ok: true, png: 'aaa' }
      }
      if (op === 'input') {
        return { ok: true, done: fields.actions, cursor: { x: 1, y: 2 } }
      }
      return { ok: true }
    },
  }
}

test('act 默认硬关', async () => {
  delete process.env.DSH_PET_ENHANCE_ACT
  const tool = createActTool({ home, log() {} })
  const r = await tool.execute({ action: 'screen' })
  assert.match(r.text, /硬关|鼠标/)
  assert.equal(r.meta.code, 'ACT_REMOVED')
})

test('act 启用后可调 sidecar input（L0/L1 无需确认）', async () => {
  let seen
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => true,
    sidecar: mockSidecar({
      input: (fields) => {
        seen = fields
        return { ok: true, done: [{ kind: 'screen', ms: 0 }], cursor: { x: 1, y: 2 } }
      },
    }),
  })
  const r = await tool.execute({ action: 'screen', reason: '读光标' })
  assert.equal(r.meta.ok, true)
  assert.equal(seen.actions[0].kind, 'screen')
  assert.equal(r.meta.tier, 'L0')
})

test('disarmed 时拒绝并标 aborted', async () => {
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => false,
    sidecar: mockSidecar(),
  })
  const r = await tool.execute({ action: 'click', x: 10, y: 10 })
  assert.equal(r.meta.aborted, true)
  assert.equal(r.meta.code, 'DISARMED')
})

test('settings.actEnabled 无效：产品硬关仍 ACT_REMOVED', async () => {
  delete process.env.DSH_PET_ENHANCE_ACT
  await saveSettings(home, { actEnabled: true })
  const tool = createActTool({
    home,
    log() {},
    isArmed: () => true,
    sidecar: mockSidecar(),
  })
  const r = await tool.execute({ action: 'move', x: 10, y: 10 })
  assert.equal(r.meta.ok, false)
  assert.equal(r.meta.code, 'ACT_REMOVED')
})

test('黑名单窗口拒绝点击', async () => {
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => true,
    sidecar: mockSidecar({
      stats: () => ({
        ok: true,
        active: { title: '1Password' },
        atPoint: { title: '1Password' },
        screen: { w: 1920, h: 1080 },
      }),
    }),
  })
  const r = await tool.execute({ action: 'click', x: 10, y: 10, reason: '点一下' })
  assert.equal(r.meta.ok, false)
  assert.equal(r.meta.code, 'DENIED_WINDOW')
})

test('前台是桌宠、点下方是密码本 → 仍拒绝并通知', async () => {
  let denied = null
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => true,
    onPolicyDeny: async (info) => { denied = info },
    sidecar: mockSidecar({
      stats: () => ({
        ok: true,
        active: { title: 'dsh-pet 桌宠（桌面模式）' },
        atPoint: { title: '密码本.txt - 记事本' },
        screen: { w: 1920, h: 1080 },
      }),
    }),
  })
  const r = await tool.execute({ action: 'click', x: 100, y: 100, reason: '点中间' })
  assert.equal(r.meta.ok, false)
  assert.equal(r.meta.code, 'DENIED_WINDOW')
  assert.match(r.text, /黑名单/)
  assert.equal(denied?.code, 'DENIED_WINDOW')
  assert.match(String(denied?.userBubble || ''), /黑名单/)
})

test('L2 用户点不要 → 不执行 input', async () => {
  let inputCalls = 0
  const gate = createConfirmGate({ timeoutMs: 5_000 })
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => true,
    confirmGate: gate,
    sidecar: mockSidecar({
      input: () => {
        inputCalls += 1
        return { ok: true, done: [], cursor: { x: 0, y: 0 } }
      },
    }),
  })
  const pending = tool.execute({ action: 'click', x: 10, y: 10, reason: '点保存' })
  await new Promise((r) => setTimeout(r, 5))
  const id = gate.getPending()?.id
  assert.ok(id)
  gate.resolve(id, false)
  const r = await pending
  assert.equal(r.meta.code, 'CONFIRM_DENIED')
  assert.equal(inputCalls, 0)
})

test('L2 用户点好 → 执行并写审计', async () => {
  const gate = createConfirmGate({ timeoutMs: 5_000 })
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => true,
    confirmGate: gate,
    budget: createActionBudget(),
    sidecar: mockSidecar({
      capture: () => ({ ok: true, png: `shot-${Date.now()}-${Math.random()}` }),
    }),
  })
  const pending = tool.execute({ action: 'click', x: 10, y: 10, reason: '点保存' })
  await new Promise((r) => setTimeout(r, 5))
  gate.resolve(gate.getPending().id, true)
  const r = await pending
  assert.equal(r.meta.ok, true)
  assert.equal(r.meta.tier, 'L2')
  assert.equal(r.meta.confirmed, true)
  assertLosslessJson(r)
  const lines = readFileSync(actionsFilePath(home), 'utf8').trim().split('\n')
  const last = JSON.parse(lines.at(-1))
  assert.equal(last.action, 'click')
  assert.equal(last.confirmed, true)
  assert.equal(last.ok, true)
})

test('策略拒绝路径返回值是 lossless JSON（无 budget 字段泄漏 undefined）', async () => {
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => true,
    budget: createActionBudget(),
    sidecar: mockSidecar({
      stats: () => ({
        ok: true,
        active: { title: '豆包' },
        atPoint: { title: '豆包' },
        screen: { w: 2560, h: 1600 },
      }),
    }),
  })
  const r = await tool.execute({
    action: 'click',
    x: -1080,
    y: 890,
    reason: '点输入框准备输入',
  })
  assert.equal(r.meta.ok, false)
  assert.equal(r.meta.code, 'COORDS_OUT_OF_SCREEN')
  assert.equal(Object.hasOwn(r.meta, 'budget'), false)
  assertLosslessJson(r)
})

test('多屏负坐标：stats 带 virtual 时放行并执行', async () => {
  let seen
  const tool = createActTool({
    home,
    log() {},
    isActEnabled: () => true,
    isArmed: () => true,
    budget: createActionBudget(),
    sidecar: mockSidecar({
      stats: () => ({
        ok: true,
        active: { title: '豆包' },
        atPoint: { title: '豆包' },
        screen: {
          w: 2560,
          h: 1600,
          virtual: { x: -1920, y: 0, w: 4480, h: 1600 },
        },
      }),
      input: (fields) => {
        seen = fields
        return { ok: true, done: fields.actions, cursor: { x: -1080, y: 890 } }
      },
    }),
  })
  const r = await tool.execute({
    action: 'click',
    x: -1080,
    y: 890,
    reason: '点输入框准备输入',
  })
  assert.equal(r.meta.ok, true)
  assert.equal(seen.actions.some((a) => a.kind === 'click' && a.x === -1080), true)
  assertLosslessJson(r)
})

test('asToolOutput 去掉 undefined / 非有限数字', () => {
  const dirty = {
    text: 'x',
    meta: {
      ok: false,
      code: 'COORDS_OUT_OF_SCREEN',
      budget: undefined,
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
    },
  }
  const clean = asToolOutput(dirty)
  assert.equal(Object.hasOwn(clean.meta, 'budget'), false)
  assert.equal(clean.meta.x, null)
  assert.equal(clean.meta.y, null)
  assertLosslessJson(clean)
})
