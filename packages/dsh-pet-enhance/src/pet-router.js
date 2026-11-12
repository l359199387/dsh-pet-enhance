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
import { isEnhanceSelfTalk, isRunAutomationIntent, shouldLeaveCoaching } from './intent.js'
import { listLearnedIndex } from './learned-automation.js'
import { listSkillGoals, listTeachSkills } from './skill-match.js'
import { mnemonBubbleSuffix } from './teach-skill.js'
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
      titleHint: '新聊天',
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

  /** 「学会了吗」对照 ~/.dsh/skills，不叫醒主会话。 */
  async function answerSkillStatus(userText) {
    if (!isSkillStatusQuestion(userText)) return false
    if (isRunAutomationIntent(userText)) return false
    const list = await listTeachSkills()
    const q = String(userText).toLowerCase()
    if (!list.length) {
      const legacy = options.home ? await listLearnedIndex(options.home).catch(() => []) : []
      if (!legacy.length) {
        await sayConclusionToPet(
          `还没学会呢。对我说「我教你…」，做成了后会写入本机技能。${mnemonBubbleSuffix()}`,
          { pet, duration: 14_000, memoryPath: options.petMemoryPath },
        )
        return true
      }
    }
    let hit = list.find((row) => {
      const goal = String(row.goal || '').trim()
      if (!goal) return false
      const g = goal.toLowerCase()
      return q.includes(g) || g.split(/[\s，,。、]+/).filter((t) => t.length >= 2).some((t) => q.includes(t))
    })
    if (hit) {
      await sayConclusionToPet(
        `学会了「${String(hit.goal).slice(0, 40)}」（技能 ${hit.name}）。要我跑一次吗？${mnemonBubbleSuffix()}`,
        { pet, duration: 12_000, memoryPath: options.petMemoryPath },
      )
    } else {
      const recent = list.slice(0, 3).map((r) => `「${String(r.goal || '?').slice(0, 24)}」`).join('、')
      await sayConclusionToPet(
        `这件事我还没学会。最近技能：${recent || '（空）'}。想教我直接说。`,
        { pet, duration: 14_000, memoryPath: options.petMemoryPath },
      )
    }
    return true
  }

  async function loadLearnedGoals() {
    try {
      const goals = await listSkillGoals()
      if (goals.length) return goals
      if (!options.home) return []
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
    if (isEnhanceSelfTalk(userText)) {
      log(`pet-router：忽略插件自述回声 ← ${String(userText).slice(0, 40)}`)
      return
    }
    let teaching = Boolean(options.teachBridge?.isTeaching?.())
    if (teaching && shouldLeaveCoaching(userText)) {
      try { options.teachBridge?.cancelTeachingQuiet?.('leave-coaching') } catch { /* ignore */ }
      teaching = false
      log('pet-router：带教态已安静退出，改走正常分流')
    }
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
      // 对话带教：每一句交给 coach（做成了/纠正/本步/开场由模型再分）
      if (typeof options.teachBridge?.handleCoachUtterance === 'function') {
        await options.teachBridge.handleCoachUtterance(userText)
        return
      }
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
        // 纯闲聊由 dsh-pet 模型答；此处只兜底执行口令 / 学会了吗 / 技能匹配
        if (isRunAutomationIntent(userText)) {
          const ran = await options.teachBridge.tryRunMatchingPlaybook?.(userText)
          if (ran) break
        }
        if (await answerSkillStatus(userText)) break
        const ran = await options.teachBridge.tryRunMatchingPlaybook?.(userText)
        if (ran) break
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
