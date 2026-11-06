/**
 * 教学模式：只记操作 → Host 短消化成 playbook → 不懂就问 → 脚本步本地跑，glance 步短叫醒。
 *
 * 敏感窗/密码类输入：只落本地 secrets，发给模型的提示里不出现原文。
 *
 * @module src/teach-bridge.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import {
  isTeachEndIntent,
  isTeachStartIntent,
  TEACH_FOLLOWUP_PREFIX,
  AGENT_WAKE_PREFIX,
} from './intent.js'
import {
  appendTeachEvent,
  buildPlaybook,
  buildPublicPlan,
  compactGlanceHints,
  createTeachSession,
  detectTeachAmbiguities,
  findPlaybookForQuery,
  narratePlan,
  newTeachSessionId,
  readPlaybook,
  readTeachEvents,
  readTeachSecrets,
  savePlaybook,
  updateTeachMeta,
} from './teach-store.js'
import { isActEnabled, isLiveWatchEnabled, loadSettings } from './settings.js'
import { glancePersonaBlock } from './persona.js'
import { wakeSession, waitAssistantReply } from './wake-session.js'

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

/** @deprecated 旧全量证据提示；现主路径用 buildTeachGlancePrompt。 */
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

/** @deprecated 全量理解提示过长；保留兼容测试。 */
export function buildTeachUnderstandPrompt(goal, steps, sessionId) {
  const evidence = steps.map((s, i) => {
    const n = i + 1
    const win = s.window ? `窗口「${String(s.window).slice(0, 40)}」` : '窗口未知'
    if (s.secretRef) {
      return (
        `${n}. 演示了一次敏感输入（${win}）。`
        + `需要时用 act type secretRef=${sessionId}/${s.secretRef}；禁止索要或复述明文。`
      )
    }
    if (s.action === 'type') {
      return `${n}. 演示输入「${clip(s.text, 48)}」（${win}）`
    }
    if (s.action === 'key') {
      return `${n}. 演示按键 ${s.keys}（${win}）`
    }
    return (
      `${n}. 演示在 ${win} 附近${s.action}，示意坐标约(${s.x},${s.y})`
      + '——坐标仅供参考，界面若变了请自己 glance 找目标。'
    )
  }).join('\n')

  return (
    `${AGENT_WAKE_PREFIX}${TEACH_FOLLOWUP_PREFIX}`
    + `用户刚演示了一遍。目标：「${String(goal || '').slice(0, 120)}」。\n`
    + '下面是观测证据（请理解流程，不要当成必须逐点重放的脚本）：\n'
    + `${evidence}\n\n`
    + '请真正理解后完成目标：先 glance 看清当前屏幕，再用 act 操作；'
    + '敏感输入只用 secretRef；完成后用一两句口语汇报。\n\n'
    + glancePersonaBlock()
  )
}

/**
 * 仅 glance 步的短提示（脚本步已由 Host 跑或不送）。
 * @param {object} playbook
 */
export function buildTeachGlancePrompt(playbook) {
  const hints = compactGlanceHints(playbook) || '(无)'
  return (
    `${AGENT_WAKE_PREFIX}${TEACH_FOLLOWUP_PREFIX}`
    + `已学 playbook ${playbook.id}。目标：「${clip(playbook.goal, 80)}」。`
    + `脚本步宿主已处理或可本地跑；只需你处理 glance 步：${hints}。`
    + '先 glance 再 act；坐标是示意；敏感输入用 secretRef；一两句汇报。'
    + `\n${glancePersonaBlock()}`
  )
}

function stepToActArgs(step, sessionId) {
  if (step.secretRef) {
    const ref = String(step.secretRef).includes('/')
      ? step.secretRef
      : `${sessionId}/${step.secretRef}`
    return {
      action: 'type',
      secretRef: ref,
      reason: step.reason || 'teach-script',
      _teachReplay: true,
    }
  }
  if (step.action === 'type') {
    return { action: 'type', text: step.text || '', reason: step.reason || 'teach-script', _teachReplay: true }
  }
  if (step.action === 'key') {
    return { action: 'key', keys: step.keys, reason: step.reason || 'teach-script', _teachReplay: true }
  }
  return {
    action: step.action,
    x: step.hint?.x ?? step.x,
    y: step.hint?.y ?? step.y,
    button: step.button || 'left',
    reason: step.reason || 'teach-script',
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
 *   isLiveWatchEnabled?: (home: string) => boolean,
 *   ensureLiveWatch?: (on: boolean) => Promise<void>,
 *   runAct?: (args: object) => Promise<{ text?: string, meta?: object }>,
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   pollChat?: boolean,
 *   onTeaching?: (on: boolean) => void,
 * }} options
 */
export function createTeachBridge(options) {
  const pet = options.petId || 'main'
  const log = options.log ?? (() => {})
  const intervalMs = options.intervalMs ?? 2_000
  const actOn = options.isActEnabled ?? isActEnabled
  const liveOn = options.isLiveWatchEnabled ?? isLiveWatchEnabled
  const pollChat = options.pollChat !== false
  const wake = options.wake ?? wakeSession
  const waitReply = options.waitReply ?? waitAssistantReply

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
  /** @type {string | null} 最近一次落盘的 playbook id，便于「再做一次」 */
  let lastPlaybookId = null

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

  /**
   * 教学需要实时看屏幕，才能把界面变化消化得更深。
   * 未开则提示主人；可确认后代开；拒绝则不开课。
   * @returns {Promise<boolean>}
   */
  async function ensureLiveWatchForTeach() {
    let on = false
    try {
      on = liveOn(options.home)
    } catch {
      const s = await loadSettings(options.home).catch(() => ({ liveWatch: false }))
      on = Boolean(s.liveWatch)
    }
    if (on) return true

    await broadcastToDshPet(
      '学的时候要开「实时看屏幕」，我才能看得更清楚。请右键「更多」打开，或点头上确认让我帮你开。',
      { pet, duration: 14_000 },
    )

    if (options.confirmGate?.ask) {
      const verdict = await options.confirmGate.ask({
        summary: '教学需要打开「实时看屏幕」，现在打开吗？',
        tier: 'L2',
        action: { teach: 'enable-live-watch' },
      })
      if (verdict.allow) {
        if (typeof options.ensureLiveWatch === 'function') {
          await options.ensureLiveWatch(true)
        } else {
          const { saveSettings } = await import('./settings.js')
          await saveSettings(options.home, { liveWatch: true })
        }
        await broadcastToDshPet('好，实时看屏幕已开，开始学。', { pet, duration: 6_000 })
        return true
      }
      await broadcastToDshPet(
        '没开实时看屏幕我就学不深。你打开后再教我一遍吧。',
        { pet, duration: 12_000 },
      )
      return false
    }

    // 无确认闸：只提示，不开课（避免默默学浅）
    log('teach：实时看屏幕未开，已提示主人')
    return false
  }

  async function startTeaching(userText) {
    if (teaching) {
      await broadcastToDshPet('已经在学啦。你继续操作；做完告诉我一声。', { pet, duration: 8_000 })
      return
    }
    const sc = sidecar()
    if (!sc?.isAlive?.()) {
      await broadcastToDshPet('录操作需要 Python sidecar，当前不可用。', { pet, duration: 10_000 })
      return
    }
    if (!(await ensureLiveWatchForTeach())) return

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
      `好，我看着学（实时看屏幕已开）。目标：${clip(goal, 40)}。你操作；做完告诉我。我会短消化成脚本，不懂就问你。密码只记本地。`,
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
    if (!askedIdle && stepIndex > 0 && Date.now() - lastEventAt > 25_000) {
      askedIdle = true
      await broadcastToDshPet(
        '还在教吗？做完了告诉我一声；有哪步我没看懂也请直接说。',
        { pet, duration: 10_000 },
      )
    }
  }

  /** 歧义追问：不懂就问清（confirm 气泡）。 */
  async function clarifyAmbiguities(id, runGoal, steps) {
    const questions = detectTeachAmbiguities(runGoal, steps)
    if (!questions.length) return { ok: true }
    if (!options.confirmGate?.ask) {
      // 无确认闸时：目标不清则停，避免瞎跑
      if (questions.some((q) => q.code === 'goal' || q.code === 'empty')) {
        await broadcastToDshPet(
          `我还不懂：${questions[0].summary}请再说清楚目标后再教一次。`,
          { pet, duration: 14_000 },
        )
        return { ok: false, reason: 'need-clarify' }
      }
      return { ok: true }
    }
    for (const q of questions) {
      await broadcastToDshPet(`有一点要问清：${q.summary}`, { pet, duration: 10_000 })
      const verdict = await options.confirmGate.ask({
        summary: q.summary,
        tier: 'L2',
        action: { teachSession: id, clarify: q.code },
      })
      if (!verdict.allow) {
        await broadcastToDshPet('好，先停。想清楚了再教我。', { pet, duration: 8_000 })
        await updateTeachMeta(options.home, id, { status: 'cancelled', clarify: q.code })
        return { ok: false, reason: 'user-deny' }
      }
    }
    return { ok: true }
  }

  async function stopAndRun() {
    if (!teaching || !sessionId) {
      // 不在录制中：尝试再次执行已学 playbook
      const ran = await tryRunMatchingPlaybook('再做一次刚才教的')
      if (ran) return
      await broadcastToDshPet('现在不在教学模式。想教我直接说；要再跑已学会的也可以说。', {
        pet,
        duration: 10_000,
      })
      return
    }
    if (observeTimer) {
      clearInterval(observeTimer)
      observeTimer = null
    }
    await pollEvents()
    await observe('stop')
    teaching = false
    try { options.onTeaching?.(false) } catch { /* ignore */ }
    await callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})

    const id = sessionId
    const events = await readTeachEvents(options.home, id)
    const steps = buildPublicPlan(events)
    await updateTeachMeta(options.home, id, {
      status: 'recorded',
      endedAt: new Date().toISOString(),
      stepCount: steps.length,
    })

    if (!steps.length) {
      await broadcastToDshPet('这轮没记到点击或输入。我们再来一次？', { pet, duration: 12_000 })
      sessionId = null
      return
    }

    // Host 零模型短消化 → playbook
    const playbook = buildPlaybook(goal, steps, id)
    const clarified = await clarifyAmbiguities(id, goal, steps)
    if (!clarified.ok) {
      sessionId = null
      return
    }

    await savePlaybook(options.home, playbook)
    lastPlaybookId = id
    await updateTeachMeta(options.home, id, {
      status: 'playbook',
      playbookStats: playbook.stats,
    })

    const narrative = narratePlan(steps)
    await broadcastToDshPet(
      `消化好了：脚本 ${playbook.stats.script} 步 / 需看屏 ${playbook.stats.glance} 步。\n`
      + `${clip(narrative, 100)}\n下次同任务会少费口舌。`,
      { pet, duration: 14_000 },
    )

    if (!actOn(options.home)) {
      await broadcastToDshPet('要动手请先打开「允许动手」，然后再说去做。', { pet, duration: 12_000 })
      await updateTeachMeta(options.home, id, { status: 'awaiting-act' })
      sessionId = null
      return
    }

    await runPlaybook(playbook)
    sessionId = null
  }

  /**
   * 脚本步本地 act；仅 glance 步短叫醒（省 token）。
   * @param {object} playbook
   */
  async function runPlaybook(playbook) {
    const id = playbook.id
    await readTeachSecrets(options.home, id)
    const runAct = options.runAct
    const scriptSteps = (playbook.steps || []).filter((s) => s.mode === 'script')
    const glanceSteps = (playbook.steps || []).filter((s) => s.mode === 'glance')

    await broadcastToDshPet(
      `开始做「${clip(playbook.goal, 36)}」（脚本 ${scriptSteps.length} / 看屏 ${glanceSteps.length}）…`,
      { pet, duration: 6_000 },
    )

    if (typeof runAct === 'function' && scriptSteps.length) {
      for (let i = 0; i < scriptSteps.length; i += 1) {
        if (stopped) {
          await broadcastToDshPet('已急停，教学执行中断。', { pet, duration: 8_000 })
          await updateTeachMeta(options.home, id, { status: 'aborted' })
          return
        }
        const r = await runAct(stepToActArgs(scriptSteps[i], id))
        if (!r?.meta?.ok) {
          await broadcastToDshPet(
            `脚本第 ${i + 1} 步停了：${clip(r?.text || '失败', 80)}`,
            { pet, duration: 12_000 },
          )
          await updateTeachMeta(options.home, id, { status: 'script-failed' })
          return
        }
      }
      if (scriptSteps.length && !glanceSteps.length) {
        await broadcastToDshPet(`做完了：${clip(playbook.goal, 40)}（全脚本，未叫醒大模型）`, {
          pet,
          duration: 12_000,
        })
        await updateTeachMeta(options.home, id, {
          status: 'done',
          via: 'script-only',
          endedAt: new Date().toISOString(),
        })
        log(`teach：playbook 全脚本完成 ${id}`)
        return
      }
    }

    if (!glanceSteps.length) {
      await broadcastToDshPet(`记下了，但没有可执行步。`, { pet, duration: 8_000 })
      return
    }

    // 仅 glance：短提示叫醒
    const preferred = options.getPreferredSessionId?.() ?? null
    const prompt = buildTeachGlancePrompt(playbook)
    const woken = await wake(options.ctx, { text: prompt, preferredId: preferred })
    if (!woken.ok) {
      const why = woken.reason || 'unknown'
      await broadcastToDshPet(
        why.includes('no-session')
          ? '脚本步好了，但找不到主会话处理看屏步。请打开一个对话再说去做。'
          : `脚本步好了；看屏步没叫醒主会话（${why}）。`,
        { pet, duration: 12_000 },
      )
      await updateTeachMeta(options.home, id, { status: 'glance-wake-failed', reason: why })
      return
    }

    log(`teach：glance 短叫醒 ${woken.sessionId} hints=${compactGlanceHints(playbook)}`)
    const reply = await waitReply(options.ctx, woken.sessionId, {
      timeoutMs: 180_000,
      isAborted: () => stopped,
    })
    if (reply.ok && reply.text) {
      await broadcastToDshPet(clip(reply.text, 160), { pet, duration: 14_000 })
      await updateTeachMeta(options.home, id, {
        status: 'done',
        via: 'script+glance',
        endedAt: new Date().toISOString(),
      })
    } else {
      await broadcastToDshPet(
        reply.reason === 'timeout'
          ? '看屏步超时了。playbook 已保存，下次可少费口舌再跑。'
          : '看屏步没文字结果；去主会话看看。playbook 已存。',
        { pet, duration: 12_000 },
      )
      await updateTeachMeta(options.home, id, {
        status: reply.reason === 'timeout' ? 'timeout' : 'no-reply',
        endedAt: new Date().toISOString(),
      })
    }
  }

  /**
   * 再次执行：匹配已学 playbook，省消化 token。
   * @returns {Promise<boolean>} 是否已接手处理
   */
  async function tryRunMatchingPlaybook(userText) {
    if (!actOn(options.home)) return false
    let playbook = await findPlaybookForQuery(options.home, userText)
    if (!playbook && lastPlaybookId) {
      playbook = await readPlaybook(options.home, lastPlaybookId)
    }
    if (!playbook?.steps?.length) return false

    await broadcastToDshPet(
      `找到已学「${clip(playbook.goal, 36)}」，按脚本跑（少费口舌）…`,
      { pet, duration: 8_000 },
    )
    await runPlaybook(playbook)
    return true
  }

  /** @deprecated 本地逐步；现用 runPlaybook */
  async function runPlanLocal(id, runGoal, steps) {
    const playbook = buildPlaybook(runGoal, steps, id)
    await savePlaybook(options.home, playbook)
    await runPlaybook(playbook)
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
    if (!pollChat) return
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
    tryRunMatchingPlaybook,
    runPlaybook,
    runPlanLocal,
    buildTeachUnderstandPrompt,
    buildTeachGlancePrompt,
    stepToActArgs,
  }
}
