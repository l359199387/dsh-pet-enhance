/**
 * 直接读写 dsh-pet 的 memory.json（用于盯屏分张：保留附图、去掉「嗯/好」短回复）。
 *
 * @module src/pet-chat-memory.js
 */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
