/**
 * 统一消费 dsh-pet /chat：先极低 token 分流，再交给对应桥。
 * 避免 chat / agent / teach 三桥各自轮询、重复分类。
 *
 * @module src/pet-router.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import {
  classifyUtterance,
  isClassifyEcho,
  isSkillStatusQuestion,
} from './classify-utterance.js'
import { listLearnedIndex } from './learned-automation.js'

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
      '小蓝鲸已接入：随便聊；想看屏幕、教我操作、或让我动手，直接说就行，我会先判断再行动。',
      { pet, duration: 10_000 },
    )
    if (!r.ok || r.data?.ok === false) {
      log(`pet-router 接入提示失败：${r.error || r.data?.reason || r.status}`)
      greeted = false
    }
  }

  /** 「学会了吗」对照本地学习文件（与自动化 1:1），不叫醒主会话。 */
  async function answerSkillStatus(userText) {
    if (!options.home || !isSkillStatusQuestion(userText)) return false
    const list = await listLearnedIndex(options.home)
    const q = String(userText).toLowerCase()
    if (!list.length) {
      await broadcastToDshPet(
        '还没学会呢。开「实时看屏幕」教我一遍，做完告诉我；问清后我会写成学习文件并建对应自动化。',
        { pet, duration: 14_000 },
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
        await broadcastToDshPet(
          `「${String(hit.goal).slice(0, 36)}」旧记录已作废（教完曾误动手）。请开实时看屏幕再教一遍。`,
          { pet, duration: 14_000 },
        )
        return true
      }
      await broadcastToDshPet(
        `学会了「${String(hit.goal).slice(0, 40)}」，对应自动化已建好。要我跑一次吗？`,
        { pet, duration: 12_000 },
      )
    } else {
      const recent = list.slice(0, 3).map((r) => `「${String(r.goal || '?').slice(0, 24)}」`).join('、')
      await broadcastToDshPet(
        `这件事我还没学会。最近学习记录：${recent || '（空）'}。想教我直接说。`,
        { pet, duration: 14_000 },
      )
    }
    return true
  }

  /**
   * @param {string} userText
   */
  async function route(userText) {
    const teaching = Boolean(options.teachBridge?.isTeaching?.())
    const preferredId = options.getPreferredSessionId?.() ?? null
    const { label, via } = await classify(options.ctx, userText, {
      teaching,
      preferredId,
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
      case 'task': {
        // 已学 playbook 优先：再次执行少消化 token
        const ran = await options.teachBridge.tryRunMatchingPlaybook?.(userText)
        if (ran) break
        await options.agentBridge.handleTask(userText)
        break
      }
      case 'chat':
      default:
        await answerSkillStatus(userText)
        break
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
