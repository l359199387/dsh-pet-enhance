import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConfirmGate } from '../src/confirm.js'

test('确认：允许 / 拒绝 / 超时', async () => {
  const seen = []
  const gate = createConfirmGate({
    timeoutMs: 80,
    onPending: (p) => seen.push(p),
  })

  const p1 = gate.ask({ summary: '点保存', tier: 'L2' })
  assert.ok(gate.getPending()?.id)
  assert.ok(seen.at(-1)?.summary.includes('保存'))
  const id = gate.getPending().id
  assert.equal(gate.resolve(id, true), true)
  const v1 = await p1
  assert.equal(v1.allow, true)
  assert.equal(v1.via, 'user-allow')
  assert.equal(gate.getPending(), null)

  const p2 = gate.ask({ summary: '删文件', tier: 'L3' })
  const id2 = gate.getPending().id
  gate.resolve(id2, false)
  const v2 = await p2
  assert.equal(v2.allow, false)
  assert.equal(v2.via, 'user-deny')

  const p3 = gate.ask({ summary: '超时测', tier: 'L2' })
  const v3 = await p3
  assert.equal(v3.allow, false)
  assert.equal(v3.via, 'timeout')
})

test('cancelAll 拒绝全部挂起', async () => {
  const gate = createConfirmGate({ timeoutMs: 5_000 })
  const p = gate.ask({ summary: 'x', tier: 'L2' })
  gate.cancelAll('panic')
  const v = await p
  assert.equal(v.allow, false)
  assert.equal(v.via, 'panic')
})
