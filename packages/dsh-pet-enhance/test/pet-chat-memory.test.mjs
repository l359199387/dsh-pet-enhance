import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  appendPetChatMessages,
  isShortAckReply,
  sayConclusionToPet,
  stripTrailingShortAcks,
} from '../src/pet-chat-memory.js'

const dir = mkdtempSync(join(tmpdir(), 'pet-chat-mem-'))
const memoryPath = join(dir, 'memory.json')
after(() => rmSync(dir, { recursive: true, force: true }))

test('isShortAckReply', () => {
  assert.equal(isShortAckReply('嗯'), true)
  assert.equal(isShortAckReply('好的呀这不是短应答'), false)
})

test('appendPetChatMessages：学会内容写入聊天记录', async () => {
  const r = await appendPetChatMessages(
    [
      { role: 'user', content: '【教学结束】我教完了' },
      { role: 'assistant', content: '我学会了「和豆包聊天」。\n理解：闲聊几句看回复。' },
    ],
    { memoryPath, petId: 'main' },
  )
  assert.equal(r.ok, true)
  assert.equal(r.added, 2)
  const mem = JSON.parse(readFileSync(memoryPath, 'utf8'))
  const msgs = mem.main.main.messages
  assert.equal(msgs.at(-2).role, 'user')
  assert.match(msgs.at(-1).content, /我学会了/)
})

test('sayConclusionToPet：冒泡并写入 assistant', async () => {
  const bubbles = []
  const r = await sayConclusionToPet('主会话已点完确定。', {
    memoryPath,
    pet: 'main',
    broadcast: async (text) => {
      bubbles.push(text)
      return { ok: true, data: { ok: true } }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.recorded, true)
  assert.deepEqual(bubbles, ['主会话已点完确定。'])
  const mem = JSON.parse(readFileSync(memoryPath, 'utf8'))
  assert.equal(mem.main.main.messages.at(-1).role, 'assistant')
  assert.match(mem.main.main.messages.at(-1).content, /点完确定/)
})

test('sayConclusionToPet：短应答只冒泡不落盘', async () => {
  const before = JSON.parse(readFileSync(memoryPath, 'utf8')).main.main.messages.length
  const r = await sayConclusionToPet('嗯', {
    memoryPath,
    broadcast: async () => ({ ok: true, data: { ok: true } }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.recorded, false)
  const after = JSON.parse(readFileSync(memoryPath, 'utf8')).main.main.messages.length
  assert.equal(after, before)
})

test('stripTrailingShortAcks 保留学会长文', async () => {
  const stripPath = join(dir, 'strip-memory.json')
  await appendPetChatMessages(
    [
      { role: 'assistant', content: '我学会了「保留长文」。' },
      { role: 'assistant', content: '嗯' },
    ],
    { memoryPath: stripPath, petId: 'main' },
  )
  const stripped = await stripTrailingShortAcks('main', { memoryPath: stripPath })
  assert.equal(stripped.ok, true)
  assert.ok(stripped.removed >= 1)
  const mem = JSON.parse(readFileSync(stripPath, 'utf8'))
  assert.match(mem.main.main.messages.at(-1).content, /我学会了/)
})
