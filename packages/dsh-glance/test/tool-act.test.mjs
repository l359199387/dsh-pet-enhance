import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createActTool } from '../src/tool-act.js'
import { saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-act-'))
after(() => {
  delete process.env.DSH_GLANCE_ACT
  rmSync(home, { recursive: true, force: true })
})

test('act 默认关闭', async () => {
  delete process.env.DSH_GLANCE_ACT
  const tool = createActTool({ home, log() {} })
  const r = await tool.execute({ action: 'screen' })
  assert.match(r.text, /未启用/)
  assert.equal(r.meta.code, 'ACT_DISABLED')
})

test('act 启用后可调 sidecar input', async () => {
  process.env.DSH_GLANCE_ACT = '1'
  let seen
  const tool = createActTool({
    home,
    log() {},
    isArmed: () => true,
    sidecar: {
      isAlive: () => true,
      async call(op, fields) {
        seen = { op, fields }
        return { ok: true, done: [{ kind: 'screen', ms: 0 }], cursor: { x: 1, y: 2 } }
      },
    },
  })
  const r = await tool.execute({ action: 'screen', reason: '读光标' })
  assert.equal(r.meta.ok, true)
  assert.equal(seen.op, 'input')
  assert.equal(seen.fields.actions[0].kind, 'screen')
})

test('disarmed 时拒绝并标 aborted', async () => {
  process.env.DSH_GLANCE_ACT = '1'
  const tool = createActTool({
    home,
    log() {},
    isArmed: () => false,
    sidecar: { isAlive: () => true, async call() { return { ok: true } } },
  })
  const r = await tool.execute({ action: 'click', x: 10, y: 10 })
  assert.equal(r.meta.aborted, true)
  assert.equal(r.meta.code, 'DISARMED')
})

test('settings.actEnabled 可打开', async () => {
  delete process.env.DSH_GLANCE_ACT
  await saveSettings(home, { actEnabled: true })
  const tool = createActTool({
    home,
    log() {},
    isArmed: () => true,
    sidecar: {
      isAlive: () => true,
      async call() {
        return { ok: true, done: [{ kind: 'move', ms: 1 }], cursor: { x: 0, y: 0 } }
      },
    },
  })
  const r = await tool.execute({ action: 'move', x: 10, y: 10 })
  assert.equal(r.meta.ok, true)
})
