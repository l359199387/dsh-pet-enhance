/**
 * 直接读写 dsh-pet 的 memory.json（盯屏分张清短应答；结论性回复写入聊天记录）。
 *
 * @module src/pet-chat-memory.js
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { broadcastToDshPet } from './dsh-pet.js'

export function defaultPetMemoryPath() {
  return join(homedir(), '.dsh', 'dsh-pet', 'memory.json')
}

/** 短应答：嗯 / 好 / 哦 / OK 等，分张中间不应留在对话里。 */
export function isShortAckReply(text) {
  const s = String(text ?? '').trim()
  if (!s || s.length > 8) return false
  return /^(嗯+|好+|哦+|喔+|啊+|行+|ok|okay|yes|收到|明白)[.。!！…]*$/i.test(s)
}

/**
 * @param {object} mem
 * @param {string} entry
 * @param {string} petId
 * @returns {{ messages: object[] } | null}
 */
function ensurePetLeaf(mem, entry, petId) {
  if (!mem[entry] || typeof mem[entry] !== 'object' || Array.isArray(mem[entry])) {
    mem[entry] = {}
  }
  const bucket = mem[entry]
  if (!bucket[petId] || typeof bucket[petId] !== 'object' || Array.isArray(bucket[petId])) {
    bucket[petId] = { messages: [] }
  }
  if (!Array.isArray(bucket[petId].messages)) {
    bucket[petId].messages = []
  }
  return bucket[petId]
}

/**
 * 往 dsh-pet 对话记忆追加消息（不叫醒模型），让「学会了什么」出现在聊天记录里。
 * @param {Array<{ role: 'user'|'assistant', content: string, ts?: number }>} messages
 * @returns {Promise<{ ok: boolean, added: number, error?: string }>}
 */
export async function appendPetChatMessages(messages, {
  petId = 'main',
  memoryPath = defaultPetMemoryPath(),
  entry = 'main',
  maxMessages = 400,
} = {}) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((m) => ({
      role: m?.role === 'user' ? 'user' : 'assistant',
      content: String(m?.content ?? '').trim().slice(0, 2000),
      ts: Number.isFinite(Number(m?.ts)) ? Number(m.ts) : Date.now(),
    }))
    .filter((m) => m.content)
  if (!list.length) return { ok: true, added: 0 }

  let mem
  try {
    mem = JSON.parse(await readFile(memoryPath, 'utf8'))
  } catch {
    mem = {}
  }
  if (!mem || typeof mem !== 'object' || Array.isArray(mem)) mem = {}

  const pet = ensurePetLeaf(mem, entry, petId)
  const base = Date.now()
  for (let i = 0; i < list.length; i += 1) {
    pet.messages.push({
      role: list[i].role,
      content: list[i].content,
      ts: list[i].ts || (base + i),
    })
  }
  if (pet.messages.length > maxMessages) {
    pet.messages = pet.messages.slice(-maxMessages)
  }

  try {
    await mkdir(dirname(memoryPath), { recursive: true })
    await writeFile(memoryPath, `${JSON.stringify(mem, null, 2)}\n`, 'utf8')
  } catch (e) {
    return { ok: false, added: 0, error: String(e?.message ?? e) }
  }
  return { ok: true, added: list.length }
}

/**
 * 结论性回复：头顶冒泡 + 写入聊天记录（进度/短应答请继续用 broadcastToDshPet）。
 * @param {string} text
 * @param {{
 *   pet?: string,
 *   duration?: number,
 *   lockId?: string,
 *   surface?: string,
 *   memoryPath?: string,
 *   record?: boolean,
 *   broadcast?: typeof broadcastToDshPet,
 *   append?: typeof appendPetChatMessages,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, recorded: boolean, broadcast?: object, error?: string }>}
 */
export async function sayConclusionToPet(text, opts = {}) {
  const content = String(text ?? '').trim()
  const pet = opts.pet || 'main'
  const record = opts.record !== false
  const broadcast = opts.broadcast ?? broadcastToDshPet
  const append = opts.append ?? appendPetChatMessages
  if (!content) {
    return { ok: false, recorded: false, error: 'empty' }
  }

  const br = await broadcast(content, {
    pet,
    duration: opts.duration ?? 12_000,
    lockId: opts.lockId,
    surface: opts.surface,
  })

  let recorded = false
  let error
  // 短应答不落盘，避免「嗯/好」污染最近聊天
  if (record && !isShortAckReply(content)) {
    const mem = await append(
      [{ role: 'assistant', content }],
      {
        petId: pet,
        memoryPath: opts.memoryPath,
      },
    ).catch((e) => ({ ok: false, added: 0, error: String(e?.message ?? e) }))
    recorded = Boolean(mem?.ok && mem.added > 0)
    if (!mem?.ok) error = mem?.error || 'record-failed'
  }

  const bubbleOk = br?.ok !== false && br?.data?.ok !== false
  return {
    ok: bubbleOk || recorded,
    recorded,
    broadcast: br,
    error,
  }
}

/**
 * 删掉某宠物消息列表末尾连续的短应答 assistant（保留带图的 user）。
 * @returns {Promise<{ ok: boolean, removed: number, error?: string }>}
 */
export async function stripTrailingShortAcks(petId = 'main', {
  memoryPath = defaultPetMemoryPath(),
  entry = 'main',
  maxRemove = 8,
} = {}) {
  let mem
  try {
    mem = JSON.parse(await readFile(memoryPath, 'utf8'))
  } catch (e) {
    return { ok: false, removed: 0, error: String(e?.message ?? e) }
  }
  if (!mem || typeof mem !== 'object') {
    return { ok: false, removed: 0, error: 'bad-memory' }
  }
  const bucket = mem[entry]
  if (!bucket || typeof bucket !== 'object') {
    return { ok: true, removed: 0 }
  }
  const pet = bucket[petId]
  if (!pet || !Array.isArray(pet.messages)) {
    return { ok: true, removed: 0 }
  }

  let removed = 0
  while (removed < maxRemove && pet.messages.length > 0) {
    const last = pet.messages[pet.messages.length - 1]
    if (last?.role !== 'assistant' || !isShortAckReply(last.content)) break
    pet.messages.pop()
    removed += 1
  }

  if (removed > 0) {
    try {
      await writeFile(memoryPath, JSON.stringify(mem, null, 2), 'utf8')
    } catch (e) {
      return { ok: false, removed: 0, error: String(e?.message ?? e) }
    }
  }
  return { ok: true, removed }
}
