/**
 * 教学模式：眼睛+操作证据 → 教完理解 → 不懂就问 → 问清后创建「学习文件↔自动化」1:1 → 再执行。
 *
 * 敏感窗/密码类输入：只落本地 secrets，发给模型的提示里不出现原文。
 *
 * @module src/teach-bridge.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import { appendPetChatMessages, sayConclusionToPet } from './pet-chat-memory.js'
import { isPetChromeTitle } from './policy.js'
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
import { appendLearnedRun } from './learned-runs.js'
import { registerHarnessAutomation } from './harness-schedule.js'
import {
  attachClickFramesToPlaybook,
  createFrameRecorder,
  describeClickFramesForPrompt,
  MAX_DIGEST_IMAGES,
  MAX_DIGEST_SHEETS,
  teachFramesDir,
} from './teach-frames.js'
import { digestEvidenceCount } from './teach-digest.js'
import { isActEnabled, isLiveWatchEnabled, loadSettings } from './settings.js'
import { glancePersonaBlock } from './persona.js'
import { wakeSession, waitAssistantReply } from './wake-session.js'
import { prepareFreshRunSession } from './session-spawn.js'
import {
  buildSmartRunPrompt,
  shouldUseSmartRun,
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

/**
 * 是否值得附图理解：键入为主、几乎没点击时只靠文字（省 token）。
 * @param {object[]} steps
 */
export function shouldAttachTeachDigestImages(steps) {
  const list = Array.isArray(steps) ? steps : []
  if (!list.length) return false
  let clicks = 0
  let typed = 0
  for (const s of list) {
    const a = String(s?.action || '')
    if (a === 'click' || a === 'double_click' || a === 'scroll') clicks += 1
    if (a === 'type' || a === 'key' || s?.kind === 'typed-text') typed += 1
  }
  if (clicks <= 0) return false
  // 大量键入、极少点击：文字摘要够用
  if (typed >= Math.max(4, clicks * 2) && clicks <= 2) return false
  return true
}

/**
 * 学完写入聊天记录的文案：目标 + 理解 + 更快做法。
 * @param {{ goal?: string, summary?: string, fastPlan?: string, id?: string }} info
 */
export function buildLearnedChatNotice(info = {}) {
  const goal = clip(String(info.goal || '这件事'), 48)
  const lines = [`我学会了「${goal}」。`]
  const summary = String(info.summary || '').trim()
  if (summary) lines.push(`理解：${clip(summary, 180)}`)
  const fast = String(info.fastPlan || '').trim()
  if (fast) lines.push(`更快做法：${clip(fast, 140)}`)
  const id = String(info.id || '').trim()
  lines.push(
    id
      ? `已写入「我学会的」（id=${clip(id, 28)}）。要跑时跟我说一声。`
      : '已写入「我学会的」。要跑时跟我说一声。',
  )
  return lines.join('\n')
}

export const TEACH_POLL_MS = 350

/** 无明确目标的「再做一次」类口令，才允许回落最近一对自动化。 */
export function isVagueReplayIntent(text) {
  const s = String(text || '').trim()
  if (!s) return false
  return /^(再做一次|再来一遍|照着做|跑一下自动化|跑自动化|执行一下|运行一下|按刚才教的(?:去做|做)?)$/i.test(s)
}

/**
 * 教学时在地址栏/搜索框留下的拼音脏数据（如 bilibli1），有理解摘要时不应盲打。
 * @param {string} text
 */
export function isLikelyAddressBarNoise(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 40) return false
  // 纯拉丁+数字、像打错的站名/拼音，而非正常中文句子
  if (!/^[a-z0-9./:_-]+$/i.test(t)) return false
  if (/https?:\/\//i.test(t) || /\.(com|cn|net|org)\b/i.test(t)) return false
  // bilibli1 / bilibili1 / dafeiyu1 这类末尾补 1 的输入法残留
  if (/^[a-z]{4,}\d$/i.test(t)) return true
  if (/bili|bilibili|bilibli/i.test(t) && !/\./.test(t)) return true
  return false
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
  if (step.action === 'scroll') {
    return {
      action: 'scroll',
      x: step.hint?.x ?? step.x,
      y: step.hint?.y ?? step.y,
      delta: step.hint?.delta ?? step.delta ?? 0,
      reason: step.reason || 'teach-script',
      _teachReplay: true,
    }
  }
  return {
    action: step.action,
    x: step.hint?.x ?? step.x,
    y: step.hint?.y ?? step.y,
    button: step.button || step.hint?.button || 'left',
    reason: step.reason || 'teach-script',
    _teachReplay: true,
  }
}

/** 回放时能否本地 act（有坐标的点击/滚动，或脚本键入）。 */
function canReplayStepLocally(step) {
  if (!step) return false
  if (step.action === 'type' || step.action === 'key') return true
  if (step.secretRef) return true
  if (step.action === 'click' || step.action === 'double_click' || step.action === 'scroll') {
    const x = step.hint?.x ?? step.x
    const y = step.hint?.y ?? step.y
    return Number.isFinite(Number(x)) && Number.isFinite(Number(y))
  }
  return false
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
 *   resetActBudget?: () => void,
 *   isAborted?: () => boolean,
 *   onSession?: (sessionId: string) => void,
 *   wake?: typeof wakeSession,
 *   waitReply?: typeof waitAssistantReply,
 *   prepareSession?: typeof prepareFreshRunSession,
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
  const prepareSession = options.prepareSession ?? prepareFreshRunSession

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
      const winTitle = norm.window?.title || null
      // 点桌宠「我教完了」：不截图、不进 digest（本地 jsonl 仍可留痕）
      const petChrome = isPetChromeTitle(winTitle)
      // 左/右/中/侧键任意点击 → 鼠标附近小图
      if (isTeachMouseClickKind(norm.kind) && frames && !petChrome) {
        shotJobs.push(frames.snapOnClick({
          eventI: norm.i,
          x: norm.x,
          y: norm.y,
          button: normalizeMouseButton(norm.button, norm.kind),
          action: norm.kind,
          window: winTitle,
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
      } else if (winTitle && frames && !petChrome) {
        shotJobs.push(frames.maybeOnWindow(winTitle))
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
  async function digestWithFrames(id, runGoal, narrative, steps = []) {
    if (!frames) {
      return { summary: narrative, fastPlan: '', usedFrames: 0, supplemented: false }
    }
    await frames.snapEnd()

    // 键入为主：不附图，只喂文字步骤（省大量视觉 token）
    if (!shouldAttachTeachDigestImages(steps)) {
      log('teach digest：键入为主，跳过附图，仅文字理解')
      const preferred = options.getPreferredSessionId?.() ?? null
      const prepared = await prepareSession(options.ctx, {
        preferredId: preferred,
        onSession: options.onSession,
        log,
      })
      const prompt = buildTeachDigestPrompt(runGoal, narrative, [])
      const woken = await wake(options.ctx, {
        text: prompt,
        sessionId: prepared.sessionId || undefined,
        preferredId: prepared.sessionId || preferred,
        log,
      })
      if (!woken.ok) {
        return { summary: narrative, fastPlan: '', usedFrames: 0, supplemented: false, textOnly: true }
      }
      try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
      const reply = await waitReply(options.ctx, woken.sessionId, {
        timeoutMs: 60_000,
        isAborted: () => stopped || Boolean(options.isAborted?.()),
      })
      const parsed = reply.ok && reply.text
        ? parseTeachDigestReply(reply.text)
        : { summary: narrative, fastPlan: '' }
      return {
        summary: parsed.summary || narrative,
        fastPlan: parsed.fastPlan || '',
        usedFrames: 0,
        digestImages: 0,
        mosaic: false,
        supplemented: false,
        textOnly: true,
        frameDir: teachFramesDir(options.home, id),
      }
    }

    const loadDigest = async () => (
      typeof frames.loadDigestImages === 'function'
        ? frames.loadDigestImages(MAX_DIGEST_IMAGES)
        : frames.loadPngBuffers(MAX_DIGEST_IMAGES)
    )
    const imgs = await loadDigest()
    if (!imgs.length) {
      return { summary: narrative, fastPlan: '', usedFrames: 0, supplemented: false }
    }

    const preferred = options.getPreferredSessionId?.() ?? null
    const prepared = await prepareSession(options.ctx, {
      preferredId: preferred,
      onSession: options.onSession,
      log,
    })
    // 默认最多 1 张 2×2（MAX_DIGEST_SHEETS 已随 budget=4 变为 1）
    const maxImages = Math.min(1, MAX_DIGEST_SHEETS, Math.max(1, imgs.length))
    const imageList = imgs.slice(0, maxImages)
    const prompt = buildTeachDigestPrompt(runGoal, narrative, imageList)
    const woken = await wake(options.ctx, {
      text: prompt,
      sessionId: prepared.sessionId || undefined,
      preferredId: prepared.sessionId || preferred,
      images: imageList,
      attachments: options.attachments,
      maxImages,
      log,
    })
    if (!woken.ok) {
      log(`teach digest 叫醒失败：${woken.reason}`)
      return { summary: narrative, fastPlan: '', usedFrames: 0, supplemented: false }
    }
    try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
    const cells = digestEvidenceCount(imageList)
    log(
      `teach digest 附图成功 ${woken.imageCount ?? 0} 张`
      + `（证据格 ${cells}；失败 ${woken.imageFailed ?? 0}；已禁 NEED_MORE 二轮）`,
    )
    const reply = await waitReply(options.ctx, woken.sessionId, {
      timeoutMs: 60_000,
      isAborted: () => stopped || Boolean(options.isAborted?.()),
    })
    const parsed = reply.ok && reply.text
      ? parseTeachDigestReply(reply.text)
      : { summary: narrative, fastPlan: '', needMore: false }
    // 故意不再因 NEED_MORE 补帧二轮喂图（token 杀手）

    return {
      summary: parsed.summary || narrative,
      fastPlan: parsed.fastPlan || '',
      usedFrames: digestEvidenceCount(imageList),
      digestImages: imageList.length,
      mosaic: Boolean(imageList[0]?.mosaic),
      supplemented: false,
      frameDir: teachFramesDir(options.home, id),
    }
  }

  /** 歧义追问：不懂就问清（confirm 气泡）。 */
  /**
   * 理解后追问；「不要」只记偏好，不再整单取消（学会条目仍会创建）。
   * @returns {Promise<{ ok: boolean, clarified: string[], denied: string[], reason?: string }>}
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
    const denied = []
    if (!questions.length) return { ok: true, clarified, denied }

    await broadcastToDshPet(
      `学完了，我要连问 ${questions.length} 件小事（头顶点「好/不要」）。点「不要」也先学会，只是按你的偏好记。`,
      { pet, duration: 10_000 },
    )

    if (!options.confirmGate?.ask) {
      // 无确认闸：默许必问项，照常建学会条目
      return { ok: true, clarified: questions.map((q) => q.code), denied }
    }
    for (const q of questions) {
      await broadcastToDshPet(`问：${clip(q.summary, 80)}`, { pet, duration: 8_000 })
      const verdict = await options.confirmGate.ask({
        summary: q.summary,
        tier: 'L2',
        action: { teachSession: id, clarify: q.code },
      })
      if (!verdict.allow) {
        denied.push(q.code)
        await broadcastToDshPet(
          '好，记下你的选择；不影响先写入「我学会的」。',
          { pet, duration: 6_000 },
        )
        continue
      }
      clarified.push(q.code)
    }
    return { ok: true, clarified, denied }
  }

  async function stopAndRun() {
    if (!teaching || !sessionId) {
      const ran = await tryRunMatchingPlaybook('再做一次刚才教的')
      if (ran) return
      await sayConclusionToPet('现在不在教学模式。想教我直接说；要跑已建好的自动化也可以说。', {
        pet,
        duration: 10_000,
        memoryPath: options.petMemoryPath,
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
      await sayConclusionToPet('这轮没记到点击或输入。我们再来一次？', {
        pet,
        duration: 12_000,
        memoryPath: options.petMemoryPath,
      })
      await turnOffLiveWatchQuiet()
      frames = null
      sessionId = null
      return
    }

    // 1) 文字步骤为主；必要时才附 1 张 2×2 点击拼图 → 模型理解；不执行
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
    const withImages = shouldAttachTeachDigestImages(steps)
    await broadcastToDshPet(
      withImages
        ? '好，我用步骤文字 + 最多一张点击拼图来理解（省 token）…'
        : '好，这轮以键入为主，我只用步骤文字理解（更省 token）…',
      { pet, duration: 6_000 },
    )
    await updateTeachMeta(options.home, id, { status: 'understanding' })
    const digested = await digestWithFrames(id, goal, narrative, steps)
    playbook.strategy = {
      approach: 'smart',
      summary: digested.summary || narrative,
      fastPlan: digested.fastPlan || '',
    }
    playbook.approach = 'smart'

    // 2) 主动多问几句；「不要」只记偏好，不撤学会
    const clarified = await clarifyAmbiguities(id, goal, steps, {
      summary: digested.summary,
      fastPlan: digested.fastPlan,
    })

    // 点「不要」的偏好：不强行变通时收紧 fastPlan
    let fastPlan = digested.fastPlan || ''
    if (clarified.denied?.includes('fast-ok') || clarified.denied?.includes('adapt')) {
      fastPlan = ''
      playbook.strategy = {
        ...(playbook.strategy || {}),
        approach: 'replay',
        fastPlan: '',
        summary: digested.summary || narrative,
      }
      playbook.approach = 'replay'
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
        fastPlan,
        approach: playbook.approach || 'smart',
        stats: playbook.stats,
        clarified: clarified.clarified,
        denied: clarified.denied || [],
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
      fastPlan,
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
      denied: clarified.denied || [],
    })

    // 6) 学完写进聊天记录（用户句 + 完整结论气泡）
    const notice = buildLearnedChatNotice({
      goal,
      summary: digested.summary || narrative,
      fastPlan,
      id,
    })
    let bubble = notice
    if (harness.ok && harness.scheduled) {
      bubble += `\n已按「${clip(harness.timingLabel || '定时', 24)}」登记到 Harness 自动化页。这次不动手。`
    } else if (harness.ok) {
      bubble += '\n未设定运行时间（你没说每周几/几点就先不排程）。这次不动手。'
    } else {
      bubble += `\nHarness 登记失败：${harness.reason || '无 schedule'}。这次不动手。`
    }
    const chatMem = await appendPetChatMessages(
      [
        { role: 'user', content: '【教学结束】我教完了' },
        { role: 'assistant', content: bubble },
      ],
      {
        petId: pet,
        memoryPath: options.petMemoryPath,
      },
    ).catch((e) => ({ ok: false, error: e?.message ?? e }))
    if (!chatMem?.ok) {
      log(`teach：写入聊天记录失败：${chatMem?.error || 'unknown'}`)
    } else {
      log(`teach：已写入聊天记录（学会「${clip(goal, 24)}」）`)
    }

    // 7) 学完自动关实时看屏幕
    await turnOffLiveWatchQuiet()
    frames = null

    // 已写入 memory，这里只冒泡（避免重复落盘）
    await broadcastToDshPet(bubble, { pet, duration: 18_000 })
    sessionId = null
  }

  /**
   * 优先按 FAST 快捷路径叫醒主会话变通执行；否则再走脚本/看屏。
   * @param {object} playbook
   */
  async function recordRun(id, info) {
    try {
      await appendLearnedRun(options.home, id, info)
    } catch (e) {
      log(`写入执行记录失败：${e?.message ?? e}`)
    }
  }

  async function runPlaybook(playbook) {
    const id = playbook.id
    // 用户再次开口跑自动化：清掉上一轮动作预算，避免「卡在第 2 步」假死
    try { options.resetActBudget?.() } catch { /* ignore */ }
    await readTeachSecrets(options.home, id)
    const runAct = options.runAct
    const learnMeta = await readLearned(options.home, id).catch(() => null)
    const summary = learnMeta?.understanding?.summary || playbook.strategy?.summary || ''
    const fastPlan = learnMeta?.understanding?.fastPlan || playbook.strategy?.fastPlan || ''
    const snap = String(summary || '').slice(0, 800)
    // 旧 playbook 里可能残留「wojiaowanle1」等教完了拼音；执行时跳过
    const scriptSteps = (playbook.steps || []).filter((s) => {
      if (s.mode !== 'script') return false
      if (s.action === 'type' && !s.secretRef && isTeachNoiseTypedText(s.text)) return false
      // 地址栏类乱码（如 bilibli1）在有学习理解时不要盲打——容易打进桌宠对话框
      if (s.action === 'type' && !s.secretRef && summary && isLikelyAddressBarNoise(s.text)) {
        return false
      }
      return true
    })
    const glanceSteps = (playbook.steps || []).filter((s) => s.mode === 'glance')
    // 仅明确 smart / 有 FAST 且用户未拒绝变通时才叫醒模型；有 summary ≠ 可以乱点
    const smart = shouldUseSmartRun(playbook, learnMeta)

    if (smart) {
      const preferred = options.getPreferredSessionId?.() ?? null
      const prepared = await prepareSession(options.ctx, {
        preferredId: preferred,
        onSession: options.onSession,
        log,
      })
      const prompt = buildSmartRunPrompt({
        ...playbook,
        strategy: {
          ...(playbook.strategy || {}),
          summary,
          fastPlan,
        },
      }, {
        ownerNotes: learnMeta?.ownerNotes || playbook.ownerNotes,
      })
      await broadcastToDshPet(
        `按快捷思路做「${clip(playbook.goal, 28)}」${fastPlan ? `：${clip(fastPlan, 36)}` : ''}…`,
        { pet, duration: 10_000 },
      )
      const woken = await wake(options.ctx, {
        text: prompt,
        sessionId: prepared.sessionId || undefined,
        preferredId: prepared.sessionId || preferred,
      })
      if (!woken.ok) {
        await broadcastToDshPet(
          `快捷路径没叫醒主会话（${woken.reason || 'unknown'}），我改按记录步骤试…`,
          { pet, duration: 10_000 },
        )
      } else {
        try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
        const reply = await waitReply(options.ctx, woken.sessionId, {
          timeoutMs: 180_000,
          isAborted: () => stopped || Boolean(options.isAborted?.()),
        })
        if (reply.ok && reply.text) {
          await sayConclusionToPet(clip(reply.text, 160), {
            pet,
            duration: 14_000,
            memoryPath: options.petMemoryPath,
          })
          await updateTeachMeta(options.home, id, {
            status: 'done',
            via: 'smart',
            endedAt: new Date().toISOString(),
          })
          await recordRun(id, {
            via: 'smart',
            ok: true,
            summary: reply.text,
            understandingSnapshot: snap,
          })
          log(`teach：smart 执行完成 ${id}`)
          return
        }
        await broadcastToDshPet('快捷路径这轮没结果，我再按记录步骤补一下…', { pet, duration: 8_000 })
      }
    }

    // replay：按教学原顺序本地回放（点击用记录的屏幕坐标），禁止先打字后点图标
    const orderedSteps = (playbook.steps || []).filter((s) => {
      if (!s) return false
      if (s.action === 'type' && !s.secretRef && isTeachNoiseTypedText(s.text)) return false
      if (s.action === 'type' && !s.secretRef && summary && isLikelyAddressBarNoise(s.text)) {
        return false
      }
      return canReplayStepLocally(s)
    })
    const leftoverGlance = (playbook.steps || []).filter(
      (s) => s && !canReplayStepLocally(s) && s.mode === 'glance',
    )

    await broadcastToDshPet(
      `开始回放「${clip(playbook.goal, 36)}」（本地 ${orderedSteps.length} 步`
      + `${leftoverGlance.length ? ` / 余 ${leftoverGlance.length} 步需看屏` : ''}）…`,
      { pet, duration: 6_000 },
    )

    if (typeof runAct === 'function' && orderedSteps.length) {
      for (let i = 0; i < orderedSteps.length; i += 1) {
        if (stopped) {
          await sayConclusionToPet('已急停，教学执行中断。', {
            pet,
            duration: 8_000,
            memoryPath: options.petMemoryPath,
          })
          await updateTeachMeta(options.home, id, { status: 'aborted' })
          await recordRun(id, {
            via: 'aborted',
            ok: false,
            summary: '用户急停，教学执行中断',
            understandingSnapshot: snap,
          })
          return
        }
        const step = orderedSteps[i]
        const win = String(step.window || '').trim()
        if (win && (step.action === 'click' || step.action === 'double_click' || step.action === 'type')) {
          await runAct({
            action: 'focus',
            window: win,
            reason: 'teach-replay-focus',
            _teachReplay: true,
          }).catch(() => null)
        }
        const r = await runAct(stepToActArgs(step, id))
        if (!r?.meta?.ok) {
          const failText = `回放第 ${i + 1} 步停了：${clip(r?.text || '失败', 80)}`
          await sayConclusionToPet(failText, {
            pet,
            duration: 12_000,
            memoryPath: options.petMemoryPath,
          })
          await updateTeachMeta(options.home, id, { status: 'script-failed' })
          await recordRun(id, {
            via: 'script-failed',
            ok: false,
            summary: failText,
            understandingSnapshot: snap,
          })
          return
        }
      }
      if (!leftoverGlance.length) {
        const doneText = `做完了：${clip(playbook.goal, 40)}（按教学顺序回放，未叫醒大模型）`
        await sayConclusionToPet(doneText, {
          pet,
          duration: 12_000,
          memoryPath: options.petMemoryPath,
        })
        await updateTeachMeta(options.home, id, {
          status: 'done',
          via: 'replay-local',
          endedAt: new Date().toISOString(),
        })
        await recordRun(id, {
          via: 'replay-local',
          ok: true,
          summary: doneText,
          understandingSnapshot: snap,
        })
        log(`teach：playbook 本地顺序回放完成 ${id}`)
        return
      }
    }

    if (!orderedSteps.length && !leftoverGlance.length && !glanceSteps.length && !scriptSteps.length) {
      await sayConclusionToPet('记下了，但没有可执行步。', {
        pet,
        duration: 8_000,
        memoryPath: options.petMemoryPath,
      })
      await recordRun(id, {
        via: 'empty',
        ok: false,
        summary: '没有可执行步',
        understandingSnapshot: snap,
      })
      return
    }

    // 余下无法本地回放的 glance 步：短提示叫醒（新开干净会话）
    const preferred = options.getPreferredSessionId?.() ?? null
    const prepared = await prepareSession(options.ctx, {
      preferredId: preferred,
      onSession: options.onSession,
      log,
    })
    const remainder = {
      ...playbook,
      steps: leftoverGlance.length ? leftoverGlance : glanceSteps,
    }
    const prompt = buildTeachGlancePrompt(remainder)
    const woken = await wake(options.ctx, {
      text: prompt,
      sessionId: prepared.sessionId || undefined,
      preferredId: prepared.sessionId || preferred,
    })
    if (!woken.ok) {
      const why = woken.reason || 'unknown'
      await sayConclusionToPet(
        why.includes('no-session')
          ? '本地步好了，但找不到主会话处理剩余看屏步。请打开一个对话再说去做。'
          : `本地步好了；剩余看屏步没叫醒主会话（${why}）。`,
        { pet, duration: 12_000, memoryPath: options.petMemoryPath },
      )
      await updateTeachMeta(options.home, id, { status: 'glance-wake-failed', reason: why })
      await recordRun(id, {
        via: 'glance-wake-failed',
        ok: false,
        summary: `看屏步没叫醒主会话（${why}）`,
        understandingSnapshot: snap,
      })
      return
    }

    log(`teach：glance 短叫醒 ${woken.sessionId} hints=${compactGlanceHints(remainder)}`)
    try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
    const reply = await waitReply(options.ctx, woken.sessionId, {
      timeoutMs: 180_000,
      isAborted: () => stopped || Boolean(options.isAborted?.()),
    })
    if (reply.ok && reply.text) {
      await sayConclusionToPet(clip(reply.text, 160), {
        pet,
        duration: 14_000,
        memoryPath: options.petMemoryPath,
      })
      await updateTeachMeta(options.home, id, {
        status: 'done',
        via: 'replay+glance',
        endedAt: new Date().toISOString(),
      })
      await recordRun(id, {
        via: 'replay+glance',
        ok: true,
        summary: reply.text,
        understandingSnapshot: snap,
      })
    } else {
      const failText = reply.reason === 'timeout'
        ? '看屏步超时了。学习文件和自动化已建好，下次可直接跑。'
        : '看屏步没文字结果；去主会话看看。学习/自动化已存。'
      await sayConclusionToPet(failText, {
        pet,
        duration: 12_000,
        memoryPath: options.petMemoryPath,
      })
      await updateTeachMeta(options.home, id, {
        status: reply.reason === 'timeout' ? 'timeout' : 'no-reply',
        endedAt: new Date().toISOString(),
      })
      await recordRun(id, {
        via: reply.reason === 'timeout' ? 'timeout' : 'no-reply',
        ok: false,
        summary: failText,
        understandingSnapshot: snap,
      })
    }
  }

  /**
   * 再次执行：按 learned↔automation 1:1 匹配，省消化 token。
   * @returns {Promise<boolean>} 是否已接手处理
   */
  async function tryRunMatchingPlaybook(userText) {
    let playbook = await findAutomationForQuery(options.home, userText)
    // 仅「再做一次」这类无目标口令才回落到最近一对；避免「ibli1」误触发
    if (!playbook && lastPairId && isVagueReplayIntent(userText)) {
      playbook = await readAutomationPlaybook(options.home, lastPairId)
    }
    if (!playbook?.steps?.length) return false

    if (!actOn(options.home)) {
      await sayConclusionToPet(
        `找到自动化「${clip(playbook.goal, 36)}」，但「允许动手」还没开。`
        + '右键宠物 → 更多 → 允许动手 · 开，然后再说一次「执行一下…」。',
        { pet, duration: 14_000, memoryPath: options.petMemoryPath },
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
