import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildImageContentBlocks, followupMessage, pickSessionId, wakeSession } from '../src/wake-session.js'

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

test('followupMessage 形状', () => {
  const m = followupMessage('hello')
  assert.equal(m.role, 'user')
  assert.equal(m.content[0].text, 'hello')
  assert.equal(m.source.kind, 'dsh-pet-enhance')
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
  assert.equal(followed[0].source.kind, 'dsh-pet-enhance')
  assert.equal(flushed.length, 1)
})

test('带图 wake：source=user 且 content 含 image block', async () => {
  const followed = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent() {
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
        return { list: () => [{ id: 's1' }], async flush() { return true } }
      }
      return null
    },
  }
  const r = await wakeSession(ctx, {
    text: '看图',
    preferredId: 's1',
    images: [{ png: tinyPng, name: 'a.png' }, { png: tinyPng, name: 'b.png' }],
    attachments: {
      async saveImage({ name }) { return { id: `att-${name}` } },
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.imageCount, 2)
  assert.equal(followed[0].source.kind, 'user')
  assert.equal(followed[0].content.filter((c) => c.type === 'image').length, 2)
})

test('buildImageContentBlocks：无 saveImage 时记失败', async () => {
  const r = await buildImageContentBlocks([{ png: tinyPng }], null)
  assert.equal(r.saved, 0)
  assert.ok(r.failed >= 1)
})
