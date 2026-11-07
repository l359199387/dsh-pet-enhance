/**
 * 统一消费 dsh-pet /chat：先极低 token 分流，再交给对应桥。
 * 避免 chat / agent / teach 三桥各自轮询、重复分类。
 *
 * @module src/pet-router.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import { sayConclusionToPet } from './pet-chat-memory.js'
import {
  classifyUtterance,
  isClassifyEcho,
  isSkillStatusQuestion,
} from './classify-utterance.js'
import { isRunAutomationIntent } from './intent.js'
import { listLearnedIndex } from './learned-automation.js'
import { openNewWorkspaceSession } from './session-spawn.js'
import { getLocale } from './settings.js'
import { t } from './i18n.js'

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

/**
 * @param {{
 *   ctx: object,
 *   home: string,
 *   log?: (m: string) => void,
 *   petId?: string,
 *   intervalMs?: number,
 *   chatBridge: { handleIntent: Function },
 *   agentBridge: { handleTask: Function },
 *   teachBridge: {
 *     isTeaching: () => boolean,
 *     startTeaching: Function,
 *     stopAndRun: Function,
 *     tryRunMatchingPlaybook?: (text: string) => Promise<boolean>,
 *   },
 *   classify?: typeof classifyUtterance,
 *   getPreferredSessionId?: () => string | null,
 *   onSession?: (sessionId: string) => void,
 *   openNewSession?: (text: string) => Promise<unknown>,
 *   wasHandledByChatGate?: (user: { content: string, ts: number }) => boolean,
 * }} options
 */
export function createPetRouter(options) {
  const pet = options.petId || 'main'
  const log = options.log ?? (() => {})
  const intervalMs = options.intervalMs ?? 2_000
  const classify = options.classify ?? classifyUtterance

  let timer = null
  let stopped = false
  let lastTs = 0
  let lastContent = ''
  let busy = false
  let greetTimer = null
  let greeted = false

  async function greetOnce() {
    if (greeted || stopped) return
    greeted = true
    const r = await broadcastToDshPet(
      t(getLocale(options.home), 'bubble.greet'),
      { pet, duration: 10_000 },
    )
    if (!r.ok || r.data?.ok === false) {
      log(`pet-router 接入提示失败：${r.error || r.data?.reason || r.status}`)
      greeted = false
    }
  }

  /** 新开工作区聊天窗：复制权限、模式默认标准。 */
  async function handleNewSession(userText) {
    if (typeof options.openNewSession === 'function') {
      await options.openNewSession(userText)
      return
    }
    const preferredId = options.getPreferredSessionId?.() ?? null
    const r = await openNewWorkspaceSession(options.ctx, {
      preferredId,
      log,
    })
    if (!r.ok) {
      await sayConclusionToPet(
        `新开聊天窗失败：${r.reason || '未知'}。也可在 Harness 里点「新建会话」。`,
        { pet, duration: 12_000, memoryPath: options.petMemoryPath },
      )
      return
    }
    try { options.onSession?.(r.sessionId) } catch { /* ignore */ }
    const perm = r.permissionCopied
      ? `权限 ${r.permission || 'danger-full-access'}`
      : `权限未写上（目标 ${r.permission || 'danger-full-access'}）`
    const effort = r.reasoningEffort
      ? (r.reasoningApplied ? `推理 ${r.reasoningEffort}` : `推理 ${r.reasoningEffort} 未写上`)
      : '推理未指定'
    await sayConclusionToPet(
      `已新开工作区聊天窗（id=${String(r.sessionId).slice(0, 12)}）。`
      + `${perm}；模式 standard；${effort}。之后交办走这个窗。`,
      { pet, duration: 14_000, memoryPath: options.petMemoryPath },
    )
  }

  /** 「学会了吗」对照本地学习文件（与自动化 1:1），不叫醒主会话。 */
  async function answerSkillStatus(userText) {
    if (!options.home || !isSkillStatusQuestion(userText)) return false
    // 执行口令绝不能停在「要我跑一次吗」
    if (isRunAutomationIntent(userText)) return false
    const list = await listLearnedIndex(options.home)
    const q = String(userText).toLowerCase()
    if (!list.length) {
      await sayConclusionToPet(
        '还没学会呢。开「实时看屏幕」教我一遍，做完告诉我；问清后我会写成学习文件并建对应自动化。',
        { pet, duration: 14_000, memoryPath: options.petMemoryPath },
      )
      return true
    }
    let hit = null
    for (const row of list) {
      const goal = String(row.goal || '').trim()
      if (!goal) continue
      const g = goal.toLowerCase()
      if (q.includes(g) || g.split(/[\s，,。、]+/).filter((t) => t.length >= 2).some((t) => q.includes(t))) {
        hit = row
        break
      }
    }
    if (hit) {
      const { readLearned } = await import('./learned-automation.js')
      const learn = await readLearned(options.home, hit.id)
      if (learn?.status === 'deprecated-reteach' || learn?.deprecatedReason) {
        await sayConclusionToPet(
          `「${String(hit.goal).slice(0, 36)}」旧记录已作废（教完曾误动手）。请开实时看屏幕再教一遍。`,
          { pet, duration: 14_000, memoryPath: options.petMemoryPath },
        )
        return true
      }
      await sayConclusionToPet(
        `学会了「${String(hit.goal).slice(0, 40)}」，对应自动化已建好。要我跑一次吗？`,
        { pet, duration: 12_000, memoryPath: options.petMemoryPath },
      )
    } else {
      const recent = list.slice(0, 3).map((r) => `「${String(r.goal || '?').slice(0, 24)}」`).join('、')
      await sayConclusionToPet(
        `这件事我还没学会。最近学习记录：${recent || '（空）'}。想教我直接说。`,
        { pet, duration: 14_000, memoryPath: options.petMemoryPath },
      )
    }
    return true
  }

  /**
   * @param {string} userText
   */
  async function loadLearnedGoals() {
    if (!options.home) return []
    try {
      const list = await listLearnedIndex(options.home)
      return (list || [])
        .slice(0, 12)
        .map((r) => String(r.goal || '').trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  async function route(userText) {
    const teaching = Boolean(options.teachBridge?.isTeaching?.())
    const preferredId = options.getPreferredSessionId?.() ?? null
    const learnedGoals = teaching ? [] : await loadLearnedGoals()
    const { label, via } = await classify(options.ctx, userText, {
      teaching,
      preferredId,
      learnedGoals,
      log,
    })

    log(`pet-router：${via}/${label} ← ${userText.slice(0, 40)}`)

    if (teaching) {
      if (label === 'teach_end' || label === 'task') {
        await options.teachBridge.stopAndRun()
      }
      return
    }

    switch (label) {
      case 'glance':
        await options.chatBridge.handleIntent(userText)
        break
      case 'teach':
        await options.teachBridge.startTeaching(userText)
        break
      case 'teach_end':
        await options.teachBridge.stopAndRun()
        break
      case 'new_session':
        await handleNewSession(userText)
        break
      case 'task': {
        // 已学 playbook 优先：再次执行少消化 token
        const ran = await options.teachBridge.tryRunMatchingPlaybook?.(userText)
        if (ran) break
        // agent-bridge 会再冒「这事我来办」；此处不再重复
        await options.agentBridge.handleTask(userText)
        break
      }
      case 'chat':
      default: {
        // 执行口令优先跑自动化，避免落到「学会了吗」闲聊
        if (isRunAutomationIntent(userText)) {
          const ran = await options.teachBridge.tryRunMatchingPlaybook?.(userText)
          if (ran) break
        }
        if (await answerSkillStatus(userText)) break
        // 「执行一下记录每日心情」等：即便粗分到 chat，也再试匹配已学自动化
        const ran = await options.teachBridge.tryRunMatchingPlaybook?.(userText)
        if (ran) break
        // 纯闲聊：不叫醒主会话，留给 dsh-pet 原生聊天回答
        break
      }
    }
  }

  async function tick() {
    if (stopped || busy) return
    const res = await callDshPet(`/chat?pet=${encodeURIComponent(pet)}&rounds=8`, {
      method: 'GET',
      timeoutMs: 4_000,
    })
    if (!res.ok) {
      if (res.error) log(`pet-router 读 /chat 失败：${res.error}`)
      return
    }
    const user = lastUserMessage(res.data?.messages)
    if (!user) return
    if (user.ts === lastTs && user.content === lastContent) return
    // 第一次只建基线，避免插件刚装上就把历史旧话又执行一遍。
    if (lastTs === 0 && lastContent === '') {
      lastTs = user.ts
      lastContent = user.content
      return
    }
    lastTs = user.ts
    lastContent = user.content
    if (isClassifyEcho(user.content)) return
    // chat-gate 已接手的任务/看屏/教学，避免 pet-router 再跑一遍
    if (options.wasHandledByChatGate?.(user)) {
      log(`pet-router：跳过（chat-gate 已接手）← ${user.content.slice(0, 40)}`)
      return
    }

    busy = true
    try {
      await route(user.content)
    } finally {
      busy = false
    }
  }

  function start() {
    if (timer) return
    stopped = false
    timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
    tick().catch(() => {})
    greetTimer = setTimeout(() => {
      greetTimer = null
      greetOnce().catch(() => {})
    }, 2_500)
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    if (greetTimer) clearTimeout(greetTimer)
    greetTimer = null
  }

  return { start, stop, tick, route }
}
