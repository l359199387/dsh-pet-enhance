/**
 * 教学模式：眼睛+操作证据 → 教完理解 → 不懂就问 → 问清后创建「学习文件↔自动化」1:1 → 再执行。
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
  isTeachNoiseTypedText,
  buildPublicPlan,
  compactGlanceHints,
  createTeachSession,
  detectTeachAmbiguities,
  isTeachMouseClickKind,
  isTeachScrollBoundaryKind,
  narratePlan,
  newTeachSessionId,
  normalizeMouseButton,
  readTeachEvents,
  readTeachSecrets,
  updateTeachMeta,
} from './teach-store.js'
import {
  createLearnedAutomationPair,
  findAutomationForQuery,
  readAutomationPlaybook,
  readLearned,
} from './learned-automation.js'
import { patchLearnedScheduleMeta } from './learned-manage.js'
import { registerHarnessAutomation } from './harness-schedule.js'
import {
  attachClickFramesToPlaybook,
  createFrameRecorder,
  describeClickFramesForPrompt,
  MAX_DIGEST_IMAGES,
  teachFramesDir,
} from './teach-frames.js'
import { isActEnabled, isLiveWatchEnabled, loadSettings } from './settings.js'
import { glancePersonaBlock } from './persona.js'
import { wakeSession, waitAssistantReply } from './wake-session.js'
import {
  buildSmartRunPrompt,
  buildTeachFollowupQuestions,
  buildTeachSmartDigestPrompt,
  mergeTeachQuestions,
  parseTeachSmartReply,
} from './teach-smart.js'

/**
 * 教学理解提示：附图证据 + 要求变通总结最快路径。
 * @param {string} goal
 * @param {string} narrative
 * @param {number|object[]} frameCountOrImages
 */
export function buildTeachDigestPrompt(goal, narrative, frameCountOrImages) {
  const images = Array.isArray(frameCountOrImages) ? frameCountOrImages : null
  const frameCount = images ? images.length : Number(frameCountOrImages) || 0
  const legend = images ? describeClickFramesForPrompt(images) : ''
  const paths = images?.length
    ? images.map((img, i) => `图${i + 1}文件：${img.path || img.name || ''}`).filter((l) => !l.endsWith('：')).join('\n')
    : ''
  const smart = buildTeachSmartDigestPrompt(goal, narrative, images || frameCount)
  return (
    `${AGENT_WAKE_PREFIX}${TEACH_FOLLOWUP_PREFIX}`
    + smart
    + (legend ? `\n附图与点击对应关系：\n${legend}\n` : '')
    + (paths ? `本地路径：\n${paths}\n` : '')
    + '「用户键入文字「…」」是亲手打的字，可进快捷路径语义。'
  )
}

export function parseTeachDigestReply(text) {
  const smart = parseTeachSmartReply(text)
  if (smart.needMore) return { ok: false, needMore: true, summary: smart.summary, fastPlan: '' }
  return {
    ok: true,
    needMore: false,
    summary: smart.summary,
    fastPlan: smart.fastPlan || '',
  }
}

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
      return `${n}. 用户键入文字「${clip(s.text, 48)}」（${win}）`
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
 *   attachments?: { saveImage?: Function },
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
  /** @type {string | null} 最近一对 learned↔automation 的 id */
  let lastPairId = null
  /** @type {ReturnType<typeof createFrameRecorder> | null} */
  let frames = null

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
    frames = createFrameRecorder({
      home: options.home,
      sessionId,
      sidecar: options.sidecar,
      capture: options.capture,
      log,
    })
    await createTeachSession(options.home, sessionId, { goal })
    const started = await observe('start')
    if (!started?.ok) {
      await broadcastToDshPet('没法开始录操作，稍后再试。', { pet, duration: 8_000 })
      frames = null
      return
    }
    teaching = true
    try { options.onTeaching?.(true) } catch { /* ignore */ }
    await callDshPet('/work-status', {
      method: 'POST',
      body: { state: 'working', task: 'teaching' },
    }).catch(() => {})
    await frames.snapStart()
    await broadcastToDshPet(
      `好，眼睛开着，我跟着学（每次点击截附近小图，只用于学会）。目标：${clip(goal, 36)}。`
      + '你点、你输入；做完点头顶「我教完了」就行。学完我会多问几句、总结更快做法再建成自动化。密码只记本地。',
      { pet, duration: 14_000 },
    )
    if (!observeTimer) {
      observeTimer = setInterval(() => { pollEvents().catch(() => {}) }, TEACH_POLL_MS)
    }
    log(`teach：开始 ${sessionId} goal=${goal}`)
  }

  async function turnOffLiveWatchQuiet() {
    if (typeof options.ensureLiveWatch !== 'function') return
    try {
      await options.ensureLiveWatch(false)
      await broadcastToDshPet('学完了，已关掉实时看屏幕。', { pet, duration: 6_000 })
    } catch (e) {
      log(`学完关实时看屏幕失败：${e?.message ?? e}`)
    }
  }

  async function pollEvents() {
    if (!teaching || !sessionId) return
    const r = await observe('poll')
    if (!r?.ok || !Array.isArray(r.events)) return
    // 截图异步排队，避免串行 await 卡住教学轮询（体感像鼠标失灵）
    const shotJobs = []
    for (const ev of r.events) {
      const norm = await appendTeachEvent(options.home, sessionId, ev, stepIndex)
      stepIndex += 1
      lastEventAt = Date.now()
      askedIdle = false
      // 左/右/中/侧键任意点击 → 鼠标附近小图
      if (isTeachMouseClickKind(norm.kind) && frames) {
        shotJobs.push(frames.snapOnClick({
          eventI: norm.i,
          x: norm.x,
          y: norm.y,
          button: normalizeMouseButton(norm.button, norm.kind),
          action: norm.kind,
          window: norm.window?.title || null,
        }))
      } else if (isTeachScrollBoundaryKind(norm.kind) && frames) {
        // 滑轮：只在手势开始/结束截，中间每格不截
        shotJobs.push(frames.snapOnScrollBoundary({
          eventI: norm.i,
          x: norm.x,
          y: norm.y,
          phase: norm.kind === 'scroll_start' ? 'start' : 'end',
          delta: norm.delta,
          horizontal: norm.horizontal,
          window: norm.window?.title || null,
        }))
      } else if (norm.window?.title && frames) {
        shotJobs.push(frames.maybeOnWindow(norm.window.title))
      }
      if (norm.sensitive && norm.kind === 'type') {
        await broadcastToDshPet('嗯，敏感输入我只记在本地了。', { pet, duration: 5_000 })
      }
    }
    if (shotJobs.length) {
      await Promise.allSettled(shotJobs)
    }
    if (!askedIdle && stepIndex > 0 && Date.now() - lastEventAt > 25_000) {
      askedIdle = true
      await broadcastToDshPet(
        '还在教吗？做完了告诉我一声；有哪步我没看懂也请直接说。',
        { pet, duration: 10_000 },
      )
    }
  }

  /**
   * 用关键帧（必要时补前后帧）喂模型理解；不执行自动化。
   * @returns {Promise<{ summary: string, usedFrames: number, supplemented: boolean }>}
   */
  async function digestWithFrames(id, runGoal, narrative) {
    if (!frames) {
      return { summary: narrative, fastPlan: '', usedFrames: 0, supplemented: false }
    }
    await frames.snapEnd()
    const loadDigest = async () => (
      typeof frames.loadDigestImages === 'function'
        ? frames.loadDigestImages(MAX_DIGEST_IMAGES)
        : frames.loadPngBuffers(MAX_DIGEST_IMAGES)
    )
    let imgs = await loadDigest()
    if (!imgs.length) {
      return { summary: narrative, fastPlan: '', usedFrames: 0, supplemented: false }
    }

    const preferred = options.getPreferredSessionId?.() ?? null
    const askOnce = async (imageList) => {
      const prompt = buildTeachDigestPrompt(runGoal, narrative, imageList)
      const woken = await wake(options.ctx, {
        text: prompt,
        preferredId: preferred,
        images: imageList,
        attachments: options.attachments,
        maxImages: MAX_DIGEST_IMAGES,
        log,
      })
      if (!woken.ok) {
        log(`teach digest 叫醒失败：${woken.reason}`)
        return { needMore: false, summary: narrative, fastPlan: '' }
      }
      log(`teach digest 附图成功 ${woken.imageCount ?? 0} 张（失败 ${woken.imageFailed ?? 0}）`)
      const reply = await waitReply(options.ctx, woken.sessionId, {
        timeoutMs: 90_000,
        isAborted: () => stopped,
      })
      if (!reply.ok || !reply.text) {
        return { needMore: true, summary: narrative, fastPlan: '' }
      }
      return parseTeachDigestReply(reply.text)
    }

    let parsed = await askOnce(imgs)
    let supplemented = false
    if (parsed.needMore) {
      await frames.supplement('before')
      await frames.supplement('after')
      imgs = await loadDigest()
      supplemented = true
      parsed = await askOnce(imgs)
    }

    return {
      summary: parsed.summary || narrative,
      fastPlan: parsed.fastPlan || '',
      usedFrames: imgs.length,
      supplemented,
      frameDir: teachFramesDir(options.home, id),
    }
  }

  /** 歧义追问：不懂就问清（confirm 气泡）。 */
  /**
   * 理解后追问；返回已澄清的 code 列表。不懂就停，不创建自动化。
   * @returns {Promise<{ ok: boolean, clarified: string[], reason?: string }>}
   */
  /**
   * @param {string} id
   * @param {string} runGoal
   * @param {object[]} steps
   * @param {{ summary?: string, fastPlan?: string }} [smart]
   */
  async function clarifyAmbiguities(id, runGoal, steps, smart = {}) {
    const mandatory = buildTeachFollowupQuestions(runGoal, steps, smart)
    const questions = mergeTeachQuestions(detectTeachAmbiguities(runGoal, steps), mandatory)
    const clarified = []
    if (!questions.length) return { ok: true, clarified }

    await broadcastToDshPet(
      `学完了，我要连问 ${questions.length} 件小事（头顶点「好/不要」），问清再建成自动化。`,
      { pet, duration: 10_000 },
    )

    if (!options.confirmGate?.ask) {
      if (questions.some((q) => q.code === 'goal' || q.code === 'empty')) {
        await broadcastToDshPet(
          `我还不懂：${questions[0].summary}请再说清楚目标后再教一次。`,
          { pet, duration: 14_000 },
        )
        return { ok: false, clarified, reason: 'need-clarify' }
      }
      // 无确认闸时仍记下必问项（视为主人默许变通）
      return { ok: true, clarified: questions.map((q) => q.code) }
    }
    for (const q of questions) {
      await broadcastToDshPet(`问：${clip(q.summary, 80)}`, { pet, duration: 8_000 })
      const verdict = await options.confirmGate.ask({
        summary: q.summary,
        tier: 'L2',
        action: { teachSession: id, clarify: q.code },
      })
      if (!verdict.allow) {
        await broadcastToDshPet('好，先不建自动化。想清楚了再教我。', { pet, duration: 8_000 })
        await updateTeachMeta(options.home, id, { status: 'cancelled', clarify: q.code })
        return { ok: false, clarified, reason: 'user-deny' }
      }
      clarified.push(q.code)
    }
    return { ok: true, clarified }
  }

  async function stopAndRun() {
    if (!teaching || !sessionId) {
      const ran = await tryRunMatchingPlaybook('再做一次刚才教的')
      if (ran) return
      await broadcastToDshPet('现在不在教学模式。想教我直接说；要跑已建好的自动化也可以说。', {
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
      await turnOffLiveWatchQuiet()
      frames = null
      sessionId = null
      return
    }

    // 1) 点击截图（含图内坐标）+ 文字 → 模型理解；不执行
    await broadcastToDshPet('好，我用每次点击的截图理解你刚才的操作…', { pet, duration: 6_000 })
    const playbook = buildPlaybook(goal, steps, id)
    if (frames) {
      attachClickFramesToPlaybook(playbook, frames.list())
    }
    const narrative = narratePlan(playbook.steps.map((s) => ({
      ...s,
      x: s.hint?.x ?? s.x,
      y: s.hint?.y ?? s.y,
      text: s.text,
      window: s.window,
    })))
    await updateTeachMeta(options.home, id, { status: 'understanding' })
    const digested = await digestWithFrames(id, goal, narrative)
    playbook.strategy = {
      approach: 'smart',
      summary: digested.summary || narrative,
      fastPlan: digested.fastPlan || '',
    }
    playbook.approach = 'smart'

    // 2) 主动多问几句，问清才继续
    const clarified = await clarifyAmbiguities(id, goal, steps, {
      summary: digested.summary,
      fastPlan: digested.fastPlan,
    })
    if (!clarified.ok) {
      await turnOffLiveWatchQuiet()
      frames = null
      sessionId = null
      return
    }

    // 3) 关键帧落入 learned/<id>/frames（仅学习用）
    let frameMeta = { count: 0, files: [] }
    if (frames) {
      frameMeta = await frames.promoteToLearned(id)
    }

    // 4) 创建学习文件 ↔ 本地自动化（同 id）——绝不自动动手
    const pair = await createLearnedAutomationPair(options.home, {
      id,
      goal,
      teachSessionId: id,
      understanding: {
        summary: digested.summary || narrative,
        fastPlan: digested.fastPlan || '',
        approach: 'smart',
        stats: playbook.stats,
        clarified: clarified.clarified,
        framesUsed: digested.usedFrames,
        framesSupplemented: digested.supplemented,
      },
      evidence: steps,
      playbook,
      frames: frameMeta,
    })
    lastPairId = id

    // 5) 登记 Harness：未明说每周几/几点 → 不定时、不开启；仅写 skill
    const preferred = options.getPreferredSessionId?.() ?? null
    const scheduleText = [
      goal,
      digested.summary,
      digested.fastPlan,
      ...(clarified.clarified || []),
    ].filter(Boolean).join('\n')
    const harness = await registerHarnessAutomation(options.ctx, {
      goal,
      learnedId: id,
      automationId: pair.task.id,
      summary: digested.summary || narrative,
      preferredSessionId: preferred,
      scheduleText,
      log,
    })

    await patchLearnedScheduleMeta(options.home, id, {
      scheduleId: harness.scheduleId || null,
      scheduleSessionId: harness.sessionId || null,
      scheduled: Boolean(harness.scheduled),
      timingLabel: harness.timingLabel || null,
      skillName: harness.skillName || null,
    })

    await updateTeachMeta(options.home, id, {
      status: 'paired',
      learnedId: pair.learn.id,
      automationId: pair.task.id,
      scheduleId: harness.scheduleId || null,
      scheduled: Boolean(harness.scheduled),
      timingLabel: harness.timingLabel || null,
      skillName: harness.skillName || null,
      harnessOk: harness.ok,
      harnessReason: harness.reason || null,
      playbookStats: playbook.stats,
      frameCount: frameMeta.count,
    })

    // 6) 学完自动关实时看屏幕
    await turnOffLiveWatchQuiet()
    frames = null

    if (harness.ok && harness.scheduled) {
      await broadcastToDshPet(
        `理解清楚了。本地学习/自动化已建（id=${clip(id, 20)}）。`
        + `已按「${clip(harness.timingLabel || '定时', 24)}」登记到 Harness 自动化页。这次不动手。`,
        { pet, duration: 18_000 },
      )
    } else if (harness.ok) {
      await broadcastToDshPet(
        `理解清楚了。本地学习文件与自动化已建（id=${clip(id, 20)}）。`
        + '未设定运行时间，也未开启定时——你没说每周几/几点就先不排程。'
        + '要跑时说「再做一次」；若要定时，教的时候说明「每天几点/每周几」。这次不动手。',
        { pet, duration: 18_000 },
      )
    } else {
      await broadcastToDshPet(
        `本地学习/自动化已建（id=${clip(id, 20)}，含 ${frameMeta.count} 张教学截图）；`
        + `Harness 登记失败：${harness.reason || '无 schedule'}。可说「再做一次」跑本地版。这次不动手。`,
        { pet, duration: 18_000 },
      )
    }
    sessionId = null
  }

  /**
   * 优先按 FAST 快捷路径叫醒主会话变通执行；否则再走脚本/看屏。
   * @param {object} playbook
   */
  async function runPlaybook(playbook) {
    const id = playbook.id
    await readTeachSecrets(options.home, id)
    const runAct = options.runAct
    // 旧 playbook 里可能残留「wojiaowanle1」等教完了拼音；执行时跳过
    const scriptSteps = (playbook.steps || []).filter((s) => {
      if (s.mode !== 'script') return false
      if (s.action === 'type' && !s.secretRef && isTeachNoiseTypedText(s.text)) return false
      return true
    })
    const glanceSteps = (playbook.steps || []).filter((s) => s.mode === 'glance')
    const smart = playbook.approach === 'smart'
      || playbook.strategy?.approach === 'smart'
      || Boolean(playbook.strategy?.fastPlan)

    if (smart) {
      const preferred = options.getPreferredSessionId?.() ?? null
      const learnMeta = await readLearned(options.home, id).catch(() => null)
      const prompt = buildSmartRunPrompt(playbook, {
        ownerNotes: learnMeta?.ownerNotes || playbook.ownerNotes,
        taskSupplement: learnMeta?.taskSupplement || playbook.taskSupplement,
      })
      await broadcastToDshPet(
        `按快捷思路做「${clip(playbook.goal, 28)}」${playbook.strategy?.fastPlan ? `：${clip(playbook.strategy.fastPlan, 36)}` : ''}…`,
        { pet, duration: 10_000 },
      )
      const woken = await wake(options.ctx, { text: prompt, preferredId: preferred })
      if (!woken.ok) {
        await broadcastToDshPet(
          `快捷路径没叫醒主会话（${woken.reason || 'unknown'}），我改按记录步骤试…`,
          { pet, duration: 10_000 },
        )
      } else {
        const reply = await waitReply(options.ctx, woken.sessionId, {
          timeoutMs: 180_000,
          isAborted: () => stopped,
        })
        if (reply.ok && reply.text) {
          await broadcastToDshPet(clip(reply.text, 160), { pet, duration: 14_000 })
          await updateTeachMeta(options.home, id, {
            status: 'done',
            via: 'smart',
            endedAt: new Date().toISOString(),
          })
          log(`teach：smart 执行完成 ${id}`)
          return
        }
        await broadcastToDshPet('快捷路径这轮没结果，我再按记录步骤补一下…', { pet, duration: 8_000 })
      }
    }

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
          ? '看屏步超时了。学习文件和自动化已建好，下次可直接跑。'
          : '看屏步没文字结果；去主会话看看。学习/自动化已存。',
        { pet, duration: 12_000 },
      )
      await updateTeachMeta(options.home, id, {
        status: reply.reason === 'timeout' ? 'timeout' : 'no-reply',
        endedAt: new Date().toISOString(),
      })
    }
  }

  /**
   * 再次执行：按 learned↔automation 1:1 匹配，省消化 token。
   * @returns {Promise<boolean>} 是否已接手处理
   */
  async function tryRunMatchingPlaybook(userText) {
    let playbook = await findAutomationForQuery(options.home, userText)
    if (!playbook && lastPairId) {
      playbook = await readAutomationPlaybook(options.home, lastPairId)
    }
    if (!playbook?.steps?.length) return false

    if (!actOn(options.home)) {
      await broadcastToDshPet(
        `找到自动化「${clip(playbook.goal, 36)}」，但「允许动手」还没开。`
        + '右键宠物 → 更多 → 允许动手 · 开，然后再说一次「执行一下…」。',
        { pet, duration: 14_000 },
      )
      return true
    }

    await broadcastToDshPet(
      `好，执行自动化「${clip(playbook.goal, 36)}」…`,
      { pet, duration: 8_000 },
    )
    await runPlaybook(playbook)
    return true
  }

  /** @deprecated */
  async function runPlanLocal(id, runGoal, steps) {
    const playbook = buildPlaybook(runGoal, steps, id)
    const pair = await createLearnedAutomationPair(options.home, {
      id,
      goal: runGoal,
      teachSessionId: id,
      understanding: { summary: narratePlan(steps), stats: playbook.stats, clarified: [] },
      evidence: steps,
      playbook,
    })
    await runPlaybook(pair.playbook)
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
