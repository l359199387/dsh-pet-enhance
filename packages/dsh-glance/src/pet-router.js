/**
 * 统一消费 dsh-pet /chat：先极低 token 分流，再交给对应桥。
 * 避免 chat / agent / teach 三桥各自轮询、重复分类。
 *
 * @module src/pet-router.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import { classifyUtterance, isClassifyEcho } from './classify-utterance.js'

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
