import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatPetConclusion } from '../src/pet-chat-memory.js'
import {
  extractAssistantTextFromSession,
  waitAssistantReply,
} from '../src/wake-session.js'

test('formatPetConclusion 保住短 SQL 块', () => {
  const raw = (
    '启用店名单可这样查：\n'
    + '```sql\nSELECT * FROM company WHERE status = 1;\n```\n'
    + '说明：status=1 表示启用。'
  )
  const out = formatPetConclusion(raw, 200)
  assert.match(out, /```sql/)
  assert.match(out, /status = 1/)
})

test('formatPetConclusion 超长截断', () => {
  const raw = '甲'.repeat(1200)
  const out = formatPetConclusion(raw, 100)
  assert.equal(out.length, 100)
  assert.ok(out.endsWith('…'))
})

test('extractAssistantTextFromSession 取最后一条助手正文', () => {
  const text = extractAssistantTextFromSession({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: '第一版' }] },
      { role: 'assistant', content: [{ type: 'text', text: '最终 SQL 结论' }] },
    ],
  })
  assert.equal(text, '最终 SQL 结论')
})

test('waitAssistantReply：工具空轮不早退，等到正文后 settle 返回', async () => {
  let seq = 0
  /** @type {object[]} */
  const events = []
  const ctx = {
    get(name) {
      if (name !== 'sessions') return null
      return {
        get() {
          return {
            get seq() { return seq },
            snapshotEvents(from) {
              return events.filter((e) => Number(e._seq) > Number(from))
            },
          }
        },
      }
    },
  }

  const pending = waitAssistantReply(ctx, 's1', {
    baselineSeq: 0,
    timeoutMs: 5_000,
    pollMs: 50,
    settleMs: 120,
  })

  await new Promise((r) => setTimeout(r, 80))
  // 工具空轮 completed
  seq = 1
  events.push({
    _seq: 1,
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })

  await new Promise((r) => setTimeout(r, 80))
  seq = 3
  events.push(
    {
      _seq: 2,
      type: 'assistant/message',
      data: {
        turn: 2,
        message: { content: [{ type: 'text', text: '这是启用店名单 SQL' }] },
      },
    },
    {
      _seq: 3,
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' } },
    },
  )

  const r = await pending
  assert.equal(r.ok, true)
  assert.match(r.text || '', /启用店名单 SQL/)
})
