/**
 * L 对话 → 叫醒主会话 Agent（看屏/GUI 委托 windows_computer_use_*）。
 *
 * @module src/agent-bridge.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import { sayConclusionToPet } from './pet-chat-memory.js'
import {
  AGENT_WAKE_PREFIX,
  isComputerTaskIntent,
  shouldSkipAgentBridge,
} from './intent.js'
import { wakeSession, waitAssistantReply, pickSessionId } from './wake-session.js'
import { prepareFreshRunSession } from './session-spawn.js'
import {
  buildComputerUseActPrompt,
  COMPUTER_USE_MISSING_BUBBLE,
  isComputerUseInstalled as detectComputerUse,
} from './computer-use-delegate.js'
import { C3_ACCEPTANCE_GOAL, isC3NotepadIntent } from './c3-task.js'

export { AGENT_WAKE_PREFIX, isComputerTaskIntent }

export function shouldWakeAgent(text) {
  if (shouldSkipAgentBridge(text)) return false
  return isComputerTaskIntent(text)
}

export function buildAgentWakePrompt(userText) {
  const notepad = isC3NotepadIntent(userText)
  const base = buildComputerUseActPrompt(userText, { notepad })
  return notepad ? `${base}目标参考：${C3_ACCEPTANCE_GOAL}。` : base
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return { content: m.content.trim(), ts: Number(m.ts) || 0 }
    }
  }
  return null
}

function clipBubble(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

/**
 * @param {{
 *   ctx: object,
 *   home: string,
 *   log?: (m: string) => void,
 *   petId?: string,
 *   intervalMs?: number,
 *   getPreferredSessionId?: () => string | null,
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   prepareSession?: typeof prepareFreshRunSession,
 *   pollChat?: boolean,
 *   onActing?: () => void,
 *   onIdle?: () => void,
 *   resetActBudget?: () => void,
 *   isAborted?: () => boolean,
 *   onSession?: (sessionId: string) => void,
 *   isComputerUseInstalled?: () => boolean,
 * }} options
 */
export function createAgentBridge(options) {
  const pet = options.petId || 'main'
  const log = options.log ?? (() => {})
  const intervalMs = options.intervalMs ?? 2_000
  const wake = options.wake ?? wakeSession
  const waitReply = options.waitReply ?? waitAssistantReply
  const prepareSession = options.prepareSession ?? prepareFreshRunSession
  const hasComputerUse = options.isComputerUseInstalled ?? detectComputerUse
  const pollChat = options.pollChat !== false
  let timer = null
  let stopped = false
  let lastTs = 0
  let lastContent = ''
  let busy = false

  async function handleTask(userText) {
    busy = true
    try {
      if (!hasComputerUse()) {
        await sayConclusionToPet(COMPUTER_USE_MISSING_BUBBLE, {
          pet,
          duration: 14_000,
          memoryPath: options.petMemoryPath,
        })
        log('agent-bridge：未检测到 dsh-computer-use-win')
        return
      }

      try { options.resetActBudget?.() } catch { /* ignore */ }
      const preferred = options.getPreferredSessionId?.() ?? null
      await broadcastToDshPet(
        '这事我来办——主会话用电脑操控（windows_computer_use_*）…',
        { pet, duration: 8_000 },
      )
      try { options.onActing?.() } catch { /* ignore */ }

      const prepared = await prepareSession(options.ctx, {
        preferredId: preferred,
        titleHint: String(userText || '').slice(0, 36) || '交办',
        onSession: options.onSession,
        log,
      })
      if (!prepared.sessionId) {
        await sayConclusionToPet(
          '我开不出新会话，也找不到可叫醒的主会话。请先在 Harness 里打开一个对话，再说一遍。',
          { pet, duration: 12_000, memoryPath: options.petMemoryPath },
        )
        log('agent-bridge：无可用会话')
        return
      }
      if (prepared.fresh) {
        log(`agent-bridge：已新开会话 ${prepared.sessionId}`)
      }

      const prompt = buildAgentWakePrompt(userText)
      const woken = await wake(options.ctx, {
        text: prompt,
        sessionId: prepared.sessionId,
        preferredId: prepared.sessionId,
      })
      if (!woken.ok) {
        const why = woken.reason || 'unknown'
        await sayConclusionToPet(
          why.includes('no-session')
            ? '我找不到可叫醒的主会话。请先在 Harness 里打开一个对话，再说一遍。'
            : `没叫醒主会话（${why}）。你可以在主会话里直接用电脑操控工具。`,
          { pet, duration: 12_000, memoryPath: options.petMemoryPath },
        )
        log(`agent-bridge 叫醒失败：${why}`)
        return
      }

      log(`agent-bridge 已叫醒会话 ${woken.sessionId}`)
      try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
      const reply = await waitReply(options.ctx, woken.sessionId, {
        timeoutMs: 360_000,
        settleMs: 2_500,
        isAborted: () => stopped || Boolean(options.isAborted?.()),
      })
      if (options.isAborted?.() || reply.reason === 'aborted') {
        if (reply.ok && reply.text) {
          await sayConclusionToPet(reply.text, {
            pet,
            duration: 14_000,
            memoryPath: options.petMemoryPath,
            maxChars: 900,
          })
        } else {
          await sayConclusionToPet('已急停，这轮先停下。', {
            pet,
            duration: 8_000,
            memoryPath: options.petMemoryPath,
          })
        }
        return
      }
      if (reply.ok && reply.text) {
        await sayConclusionToPet(reply.text, {
          pet,
          duration: 16_000,
          memoryPath: options.petMemoryPath,
          maxChars: 900,
        })
        log(`agent-bridge 已回灌结论（${reply.text.slice(0, 40)}）`)
      } else {
        await sayConclusionToPet(
          reply.reason === 'timeout'
            ? '主会话还在忙或超时了。你可以去主会话看进度，或再说一遍。'
            : '主会话这轮没给出文字结果；去主会话里看看电脑操控有没有跑完。',
          { pet, duration: 12_000, memoryPath: options.petMemoryPath },
        )
        log(`agent-bridge 等待回复：${reply.reason || 'empty'}`)
      }
    } finally {
      try { options.onIdle?.() } catch { /* ignore */ }
      busy = false
    }
  }

  async function tick() {
    if (stopped || busy) return
    const res = await callDshPet(`/chat?pet=${encodeURIComponent(pet)}&rounds=8`, {
      method: 'GET',
      timeoutMs: 4_000,
    })
    if (!res.ok) {
      if (res.error) log(`agent-bridge 读 /chat 失败：${res.error}`)
      return
    }
    const user = lastUserMessage(res.data?.messages)
    if (!user) return
    if (user.ts === lastTs && user.content === lastContent) return
    if (lastTs === 0 && lastContent === '') {
      lastTs = user.ts
      lastContent = user.content
      return
    }
    lastTs = user.ts
    lastContent = user.content
    if (!shouldWakeAgent(user.content)) return
    await handleTask(user.content)
  }

  function start() {
    stopped = false
    if (!pollChat) return
    if (timer) return
    timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
    tick().catch(() => {})
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    start,
    stop,
    tick,
    handleTask,
    isComputerTaskIntent,
    shouldWakeAgent,
    buildAgentWakePrompt,
    pickSessionId: () => pickSessionId(options.ctx, options.getPreferredSessionId?.()),
  }
}
