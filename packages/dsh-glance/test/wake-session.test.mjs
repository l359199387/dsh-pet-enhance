import assert from 'node:assert/strict'
import { test } from 'node:test'
import { followupMessage, pickSessionId, wakeSession } from '../src/wake-session.js'

test('followupMessage 形状', () => {
  const m = followupMessage('hello')
  assert.equal(m.role, 'user')
  assert.equal(m.content[0].text, 'hello')
  assert.equal(m.source.kind, 'dsh-glance')
  assert.ok(m.id)
})

test('pickSessionId：preferred > focused > 第一个', () => {
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          list: () => [
            { id: 'a' },
            { id: 'b', focused: true },
          ],
        }
      }
      return null
    },
  }
  assert.equal(pickSessionId(ctx, 'x'), 'x')
  assert.equal(pickSessionId(ctx), 'b')
})

test('wakeSession：无 controller 时明确失败', async () => {
  const r = await wakeSession({}, { text: 'hi' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-session-controller')
})

test('wakeSession：resolveAgent + followup + flush', async () => {
  const followed = []
  const flushed = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent(id) {
            assert.equal(id, 's1')
            return {
              agent: {
                session: { id: 's1' },
                followup(msg) { followed.push(msg) },
              },
            }
          },
        }
      }
      if (name === 'sessions') {
        return {
          list: () => [{ id: 's1' }],
          async flush(session) { flushed.push(session); return true },
        }
      }
      return null
    },
  }
  const r = await wakeSession(ctx, { text: '干活', preferredId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 's1')
  assert.equal(followed.length, 1)
  assert.ok(followed[0].content[0].text.includes('干活'))
  assert.equal(flushed.length, 1)
})
