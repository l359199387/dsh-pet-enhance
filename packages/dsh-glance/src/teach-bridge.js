/**
 * 教学模式：用户自己操作，小蓝鲸只记录；教完整理步骤并叫醒主会话执行目标。
 *
 * 敏感窗/密码类输入：只落本地 secrets，发给模型的计划里不出现原文。
 *
 * @module src/teach-bridge.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import {
  isTeachEndIntent,
  isTeachStartIntent,
  TEACH_FOLLOWUP_PREFIX,
} from './intent.js'
import {
  appendTeachEvent,
  buildPublicPlan,
  createTeachSession,
  narratePlan,
  newTeachSessionId,
  readTeachEvents,
  readTeachSecrets,
  updateTeachMeta,
} from './teach-store.js'
import { isActEnabled } from './settings.js'
import { glancePersonaBlock } from './persona.js'
import { AGENT_WAKE_PREFIX } from './intent.js'

export const TEACH_POLL_MS = 350

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

function clip(s, n = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/** @deprecated 回放改由 Host 本地逐步 act；保留给测试/兜底。 */
export function buildTeachExecutePrompt(goal, steps, sessionId) {
  const lines = steps.map((s, i) => {
    const n = i + 1
    if (s.secretRef) {
      return `${n}. type secretRef=${sessionId}/${s.secretRef}`
    }
    if (s.action === 'type') return `${n}. type ${JSON.stringify(s.text || '')}`
    if (s.action === 'key') return `${n}. key ${s.keys}`
    return `${n}. ${s.action} (${s.x},${s.y})`
  })
  return (
    `${AGENT_WAKE_PREFIX}${TEACH_FOLLOWUP_PREFIX}`
    + `目标：「${String(goal || '').slice(0, 120)}」。\n${lines.join('\n')}\n\n${glancePersonaBlock()}`
  )
}

function stepToActArgs(step, sessionId) {
  if (step.secretRef) {
    return {
      action: 'type',
      secretRef: `${sessionId}/${step.secretRef}`,
      reason: step.reason,
      _teachReplay: true,
    }
  }
  if (step.action === 'type') {
    return { action: 'type', text: step.text || '', reason: step.reason, _teachReplay: true }
  }
  if (step.action === 'key') {
    return { action: 'key', keys: step.keys, reason: step.reason, _teachReplay: true }
  }
  return {
    action: step.action,
    x: step.x,
    y: step.y,
    button: step.button || 'left',
    reason: step.reason,
    _teachReplay: true,
  }
}

/**
 * @param {{
 *   ctx: object,
 *   home: string,
 *   sidecar?: object | (() => object | null | undefined),
 *   log?: (m: string) => void,
 *   petId?: string,
 *   intervalMs?: number,
 *   getPreferredSessionId?: () => string | null,
 *   confirmGate?: { ask: Function },
 *   isActEnabled?: (home: string) => boolean,
 *   runAct?: (args: object) => Promise<{ text?: string, meta?: object }>,
 *   onTeaching?: (on: boolean) => void,
 * }} options
 */
export function createTeachBridge(options) {
  const pet = options.petId || 'main'
  const log = options.log ?? (() => {})
  const intervalMs = options.intervalMs ?? 2_000
  const actOn = options.isActEnabled ?? isActEnabled

  let timer = null
  let observeTimer = null
  let stopped = false
  let lastTs = 0
  let lastContent = ''
  let busy = false

  let teaching = false
  let sessionId = null
  let stepIndex = 0
  let goal = ''
  let lastEventAt = 0
  let askedIdle = false

  function sidecar() {
    return typeof options.sidecar === 'function' ? options.sidecar() : options.sidecar
  }

  async function observe(action, fields = {}) {
    const sc = sidecar()
    if (!sc?.isAlive?.() || typeof sc.call !== 'function') {
      return { ok: false, error: 'sidecar-down' }
    }
    return sc.call('observe', { action, ...fields }, 5_000)
  }

  async function startTeaching(userText) {
    if (teaching) {
      await broadcastToDshPet('已经在学啦。你继续操作，说「教完了」我就去做。', { pet, duration: 8_000 })
      return
    }
    const sc = sidecar()
    if (!sc?.isAlive?.()) {
      await broadcastToDshPet('录操作需要 Python sidecar，当前不可用。', { pet, duration: 10_000 })
      return
    }
    // 从话里抽出目标：去掉教学触发词
    goal = String(userText)
      .replace(/我?教你一下|教你一遍|学一下我的操作|跟我学一遍|看我做一遍|开始教学|进入教学/gi, '')
      .replace(/^[，,。.\s]+|[，,。.\s]+$/g, '')
      .trim()
      || '完成刚才教的流程'

    sessionId = newTeachSessionId()
    stepIndex = 0
    lastEventAt = Date.now()
    askedIdle = false
    await createTeachSession(options.home, sessionId, { goal })
    const started = await observe('start')
    if (!started?.ok) {
      await broadcastToDshPet('没法开始录操作，稍后再试。', { pet, duration: 8_000 })
      return
    }
    teaching = true
    try { options.onTeaching?.(true) } catch { /* ignore */ }
    await callDshPet('/work-status', {
      method: 'POST',
      body: { state: 'working', task: 'teaching' },
    }).catch(() => {})
    await broadcastToDshPet(
      `好，我看着学。目标：${clip(goal, 40)}。你自己操作就行；说「教完了」我就按记录去做。密码类我只记本地、不送模型。`,
      { pet, duration: 14_000 },
    )
    if (!observeTimer) {
      observeTimer = setInterval(() => { pollEvents().catch(() => {}) }, TEACH_POLL_MS)
    }
    log(`teach：开始 ${sessionId} goal=${goal}`)
  }

  async function pollEvents() {
    if (!teaching || !sessionId) return
    const r = await observe('poll')
    if (!r?.ok || !Array.isArray(r.events)) return
    for (const ev of r.events) {
      const norm = await appendTeachEvent(options.home, sessionId, ev, stepIndex)
      stepIndex += 1
      lastEventAt = Date.now()
      askedIdle = false
      if (norm.sensitive && norm.kind === 'type') {
        await broadcastToDshPet('嗯，敏感输入我只记在本地了。', { pet, duration: 5_000 })
      }
    }
    // 长时间无操作：追问一次
    if (!askedIdle && stepIndex > 0 && Date.now() - lastEventAt > 25_000) {
      askedIdle = true
      await broadcastToDshPet(
        '还在教吗？做完了就说「教完了」；要继续就接着操作。',
        { pet, duration: 10_000 },
      )
    }
  }

  async function stopAndRun() {
    if (!teaching || !sessionId) {
      await broadcastToDshPet('现在不在教学模式。想教我说「我教你一下」。', { pet, duration: 8_000 })
      return
    }
    if (observeTimer) {
      clearInterval(observeTimer)
      observeTimer = null
    }
    // 先抽干最后一批事件，再关教学态（pollEvents 依赖 teaching=true）
    await pollEvents()
    await observe('stop')
    teaching = false
    try { options.onTeaching?.(false) } catch { /* ignore */ }
    await callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})

    const events = await readTeachEvents(options.home, sessionId)
    const steps = buildPublicPlan(events)
    await updateTeachMeta(options.home, sessionId, {
      status: 'recorded',
      endedAt: new Date().toISOString(),
      stepCount: steps.length,
    })

    if (!steps.length) {
      await broadcastToDshPet('这轮没记到点击或输入。我们再来一次？说「我教你一下」。', { pet, duration: 12_000 })
      sessionId = null
      return
    }

    // 步骤很少时确认一下目标
    if (steps.length < 2 && options.confirmGate?.ask) {
      const verdict = await options.confirmGate.ask({
        summary: `只记到 ${steps.length} 步，按这个去做「${clip(goal, 30)}」吗？`,
        tier: 'L2',
        action: { teachSession: sessionId },
      })
      if (!verdict.allow) {
        await broadcastToDshPet('好，先不跑。想再教再说「我教你一下」。', { pet, duration: 8_000 })
        await updateTeachMeta(options.home, sessionId, { status: 'cancelled' })
        sessionId = null
        return
      }
    }

    const narrative = narratePlan(steps)
    await broadcastToDshPet(`记下了 ${steps.length} 步：\n${clip(narrative, 120)}\n我去做。`, {
      pet,
      duration: 12_000,
    })

    if (!actOn(options.home)) {
      await broadcastToDshPet('要动手请先打开「允许动手」，然后再说「按刚才教的去做」。', { pet, duration: 12_000 })
      await updateTeachMeta(options.home, sessionId, { status: 'awaiting-act' })
      return
    }

    await runPlan(sessionId, goal, steps)
  }

  async function runPlan(id, runGoal, steps) {
    await readTeachSecrets(options.home, id)
    const runAct = options.runAct
    if (typeof runAct !== 'function') {
      await broadcastToDshPet('回放通道没就绪，稍后再说「教完了」。', { pet, duration: 10_000 })
      await updateTeachMeta(options.home, id, { status: 'no-run-act' })
      return
    }
    await broadcastToDshPet(`开始按教学做「${clip(runGoal, 36)}」…`, { pet, duration: 6_000 })
    let ok = true
    let failText = ''
    for (let i = 0; i < steps.length; i += 1) {
      if (stopped) {
        ok = false
        failText = '已急停，教学回放中断。'
        break
      }
      const args = stepToActArgs(steps[i], id)
      const r = await runAct(args)
      if (!r?.meta?.ok) {
        ok = false
        failText = r?.text || `第 ${i + 1} 步失败`
        log(`teach：步骤 ${i + 1} 失败：${failText}`)
        break
      }
      await broadcastToDshPet(`第 ${i + 1}/${steps.length} 步好了`, { pet, duration: 3_000 })
    }
    await broadcastToDshPet(
      ok ? `做完了：${clip(runGoal, 40)}` : `做到一半停了：${clip(failText, 80)}`,
      { pet, duration: 14_000 },
    )
    await updateTeachMeta(options.home, id, {
      status: ok ? 'done' : 'failed',
      endedAt: new Date().toISOString(),
    })
    log(`teach：执行结束 ${id} ok=${ok}`)
    sessionId = null
  }

  async function tick() {
    if (stopped || busy) return
    const r = await callDshPet(`/chat?pet=${encodeURIComponent(pet)}&rounds=8`, {
      method: 'GET',
      timeoutMs: 4_000,
    })
    if (!r.ok || !r.data?.ok) return
    const msg = lastUserMessage(r.data.messages)
    if (!msg) return
    if (msg.ts && msg.ts <= lastTs && msg.content === lastContent) return
    if (msg.content.startsWith(TEACH_FOLLOWUP_PREFIX) || msg.content.startsWith(AGENT_WAKE_PREFIX)) return

    lastTs = msg.ts || Date.now()
    lastContent = msg.content
    busy = true
    try {
      if (isTeachEndIntent(msg.content) || (teaching && /按刚才教的|照着做|开始做/.test(msg.content))) {
        await stopAndRun()
        return
      }
      if (isTeachStartIntent(msg.content)) {
        await startTeaching(msg.content)
        return
      }
    } finally {
      busy = false
    }
  }

  function start() {
    stopped = false
    if (timer) return
    timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
    tick().catch(() => {})
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    if (observeTimer) clearInterval(observeTimer)
    observeTimer = null
    if (teaching) {
      teaching = false
      observe('stop').catch(() => {})
      callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})
    }
  }

  return {
    start,
    stop,
    tick,
    isTeaching: () => teaching,
    getSessionId: () => sessionId,
    startTeaching,
    stopAndRun,
  }
}
