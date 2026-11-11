/**
 * 对话带教：说话指引 / 口述 → 可沉淀脚本 → 说「做成了」落盘 LEARN v2 + coach-log。
 * 0.5+：不做鼠标键盘 act；再做一次优先跑 Python 脚本块。
 *
 * @module src/teach-bridge.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import { appendPetChatMessages, sayConclusionToPet } from './pet-chat-memory.js'
import {
  isTeachEndIntent,
  isTeachStartIntent,
  TEACH_FOLLOWUP_PREFIX,
  AGENT_WAKE_PREFIX,
} from './intent.js'
import { classifyCoachUtterance, extractCoachGoal } from './coach-intent.js'
import { appendCoachLog, promoteCoachLog, readCoachLog } from './coach-log.js'
import {
  buildCoachInducePrompt,
  buildCoachWakePrompt,
  extractConstraintsFromLog,
  parseCoachInduceReply,
} from './teach-coach.js'
import {
  buildScriptProposePrompt,
  buildScriptsConfirmSummary,
  parseScriptProposals,
  patchLearnedCapability,
  rewriteSkillWithScripts,
  runReadyCoachScripts,
  writeCoachScripts,
} from './coach-scripts.js'
import {
  buildPlaybook,
  compactGlanceHints,
  createTeachSession,
  narratePlan,
  newTeachSessionId,
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
import { describeClickFramesForPrompt } from './teach-frames.js'
import { glancePersonaBlock } from './persona.js'
import { buildC3DisciplineBlock } from './c3-task.js'
import { wakeSession, waitAssistantReply } from './wake-session.js'
import { prepareFreshRunSession } from './session-spawn.js'
import {
  buildSmartRunPrompt,
  shouldUseSmartRun,
  buildTeachSmartDigestPrompt,
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
        + `敏感输入仅本地引用 ${sessionId}/${s.secretRef}；禁止索要或复述明文；本版本不代打字。`
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
    + '请真正理解后：用 glance 看屏，用脚本/命令/写文件完成能自动化的部分；'
    + '**禁止 act**；GUI 与敏感输入改口述。完成后用一两句口语汇报。\n\n'
    + buildC3DisciplineBlock({ includeScenario: false })
    + `\n${glancePersonaBlock()}`
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
    + `脚本步宿主已处理或可本地跑；只需你 glance 核对：${hints}。`
    + '**禁止 act**；GUI 口述给用户；一两句汇报。'
    + buildC3DisciplineBlock({ includeScenario: false })
    + `\n${glancePersonaBlock()}`
  )
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
 *   isLiveWatchEnabled?: (home: string) => boolean,
 *   ensureLiveWatch?: (on: boolean) => Promise<void>,
 *   attachments?: { saveImage?: Function },
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
  const pollChat = options.pollChat !== false
  const wake = options.wake ?? wakeSession
  const waitReply = options.waitReply ?? waitAssistantReply
  const prepareSession = options.prepareSession ?? prepareFreshRunSession

  let timer = null
  let stopped = false
  let lastTs = 0
  let lastContent = ''
  let busy = false

  let teaching = false
  let sessionId = null
  let goal = ''
  /** @type {string[]} */
  let constraints = []
  let attemptCount = 0
  /** @type {string | null} */
  let lastPairId = null
  /** 本轮带教复用的主会话，避免每步都新开「未命名」 */
  /** @type {string | null} */
  let coachAgentSessionId = null
  let coachBusy = false
  /** 带教世代：结束/重开时递增，作废 await 中的迟到分流 */
  let coachEpoch = 0

  function endTeachingFlag() {
    teaching = false
    coachEpoch += 1
    coachAgentSessionId = null
    try { options.onTeaching?.(false) } catch { /* ignore */ }
    callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})
  }

  function coachStillActive(epoch, sid) {
    return teaching && sessionId === sid && coachEpoch === epoch && Boolean(sid)
  }

  async function ensureCoachAgentSession() {
    if (coachAgentSessionId) return { sessionId: coachAgentSessionId, fresh: false }
    const preferred = options.getPreferredSessionId?.() ?? null
    const prepared = await prepareSession(options.ctx, {
      preferredId: preferred,
      titleHint: `带教｜${goal || '对话带教'}`,
      onSession: options.onSession,
      log,
    })
    if (prepared.sessionId) coachAgentSessionId = prepared.sessionId
    return prepared
  }

  async function wakeCoachRound(userText) {
    const preferred = options.getPreferredSessionId?.() ?? null
    const prepared = await ensureCoachAgentSession()
    const prompt = buildCoachWakePrompt(goal, userText, {
      constraints,
      attemptCount,
    })
    const woken = await wake(options.ctx, {
      text: prompt,
      sessionId: prepared.sessionId || undefined,
      preferredId: prepared.sessionId || preferred,
      log,
    })
    if (!woken.ok) {
      await broadcastToDshPet(
        `带教这轮没叫醒主会话（${woken.reason || 'unknown'}）。你再说一次或换种说法。`,
        { pet, duration: 10_000 },
      )
      await appendCoachLog(options.home, sessionId, {
        kind: 'tool',
        summary: `wake-failed:${woken.reason || 'unknown'}`,
      })
      return { ok: false }
    }
    try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
    const reply = await waitReply(options.ctx, woken.sessionId, {
      timeoutMs: 180_000,
      isAborted: () => stopped || Boolean(options.isAborted?.()),
    })
    if (reply.ok && reply.text) {
      await sayConclusionToPet(clip(reply.text, 160), {
        pet,
        duration: 12_000,
        memoryPath: options.petMemoryPath,
      })
      await appendCoachLog(options.home, sessionId, {
        kind: 'tool',
        summary: clip(reply.text, 200),
      })
      return { ok: true, text: reply.text }
    }
    const why = reply.reason || 'empty'
    await appendCoachLog(options.home, sessionId, {
      kind: 'tool',
      summary: `no-reply:${why}`,
    })
    await broadcastToDshPet(
      why === 'empty-text'
        ? '这轮主会话没吐出文字（可能被推理折空了）。请再说一次本步，或换短一点的说法。'
        : `这轮没等到主会话回复（${why}）。请再说一次本步。`,
      { pet, duration: 12_000 },
    )
    return { ok: false, reason: why }
  }

  async function startTeaching(userText) {
    if (teaching) {
      await broadcastToDshPet(
        '已经在带教中。继续说目标/纠正即可；做成了告诉我，不想教了就说放弃。',
        { pet, duration: 8_000 },
      )
      await handleCoachUtterance(userText)
      return
    }

    // 先进入带教态，避免抽目标等待期间后续指导被闸门/router 当普通闲聊丢掉
    sessionId = newTeachSessionId()
    constraints = []
    attemptCount = 0
    goal = '完成主人要教的这件事'
    teaching = true
    coachBusy = true
    try { options.onTeaching?.(true) } catch { /* ignore */ }
    await createTeachSession(options.home, sessionId, { goal, mode: 'coach' })
    await updateTeachMeta(options.home, sessionId, { status: 'coaching', mode: 'coach' })
    await callDshPet('/work-status', {
      method: 'POST',
      body: { state: 'working', task: 'coaching' },
    }).catch(() => {})

    try {
      const preferred = options.getPreferredSessionId?.() ?? null
      goal = await extractCoachGoal(options.ctx, userText, {
        preferredId: preferred,
        wake,
        waitReply,
        log,
        fallback: goal,
      })
      await updateTeachMeta(options.home, sessionId, { goal, status: 'coaching', mode: 'coach' })
      await appendCoachLog(options.home, sessionId, {
        kind: 'open',
        text: userText,
        goal,
      })

      await broadcastToDshPet(
        `好，目标我理解成「${clip(goal, 40)}」。`
        + '请继续告诉我这一步做什么；我会按你的话一步步做，不会自己把整件事做完。'
        + '做成了告诉我；不想教了可以说放弃。',
        { pet, duration: 16_000 },
      )
      log(`coach：开始 ${sessionId} goal=${goal}（开场只抽目标，不叫醒动手）`)
    } finally {
      coachBusy = false
    }
  }

  async function finishCoachAbort(userText, epoch = coachEpoch) {
    const id = sessionId
    // 带教已结束（做成了 / stop / 世代已变）时禁止再冒「先停下」——分流 await 常会迟到
    if (!id || !teaching || epoch !== coachEpoch) {
      log('coach：忽略过期 abort')
      return
    }
    await appendCoachLog(options.home, id, {
      kind: 'gate',
      verdict: 'abort',
      text: userText,
    })
    await updateTeachMeta(options.home, id, {
      status: 'aborted',
      endedAt: new Date().toISOString(),
    })
    endTeachingFlag()
    sessionId = null
    goal = ''
    constraints = []
    attemptCount = 0
    await sayConclusionToPet('好，这轮带教先停下，没有记成学会。以后想教再说。', {
      pet,
      duration: 10_000,
      memoryPath: options.petMemoryPath,
    })
  }

  async function finishCoachVerified(userText) {
    const id = sessionId
    if (!id) return
    const savedGoal = goal
    const savedConstraints = [...constraints]
    const savedAttempts = attemptCount
    const savedAgentSessionId = coachAgentSessionId
    // 一进归纳就退出带教态，避免漫长 induce/确认期间迟到分流又判 abort
    endTeachingFlag()
    sessionId = null
    goal = ''
    constraints = []
    attemptCount = 0

    await appendCoachLog(options.home, id, {
      kind: 'gate',
      verdict: 'done',
      text: userText,
    })
    await updateTeachMeta(options.home, id, { status: 'inducing' })
    await broadcastToDshPet('好，我把这轮带教归纳成学会说明…', { pet, duration: 6_000 })

    const logRows = await readCoachLog(options.home, id)
    const fromLog = extractConstraintsFromLog(logRows)
    const mergedConstraints = [...new Set([...savedConstraints, ...fromLog])].slice(0, 12)

    const preferred = options.getPreferredSessionId?.() ?? null
    let induceSessionId = savedAgentSessionId
    const prepared = induceSessionId
      ? { sessionId: induceSessionId, fresh: false }
      : await prepareSession(options.ctx, {
        preferredId: preferred,
        titleHint: `带教归纳｜${savedGoal || '学会'}`,
        onSession: options.onSession,
        log,
      })
    if (prepared.sessionId) induceSessionId = prepared.sessionId
    const inducePrompt = buildCoachInducePrompt(savedGoal, logRows, mergedConstraints)
    let summary = `带教完成：${savedGoal}`
    let fastPlan = ''
    const woken = await wake(options.ctx, {
      text: inducePrompt,
      sessionId: induceSessionId || undefined,
      preferredId: induceSessionId || preferred,
      log,
    })
    if (woken.ok) {
      try { options.onSession?.(woken.sessionId) } catch { /* ignore */ }
      if (woken.sessionId) induceSessionId = woken.sessionId
      const reply = await waitReply(options.ctx, woken.sessionId, {
        timeoutMs: 90_000,
        isAborted: () => stopped || Boolean(options.isAborted?.()),
      })
      if (reply.ok && reply.text) {
        const parsed = parseCoachInduceReply(reply.text)
        if (parsed.summary) summary = parsed.summary
        if (parsed.fastPlan) fastPlan = parsed.fastPlan
      }
    }

    await appendCoachLog(options.home, id, {
      kind: 'induce',
      summary,
      fastPlan,
    })

    /** @type {object[]} */
    let proposedScripts = []
    const proposePrompt = buildScriptProposePrompt(savedGoal, summary, fastPlan, mergedConstraints)
    const proposeWake = await wake(options.ctx, {
      text: proposePrompt,
      sessionId: induceSessionId || undefined,
      preferredId: induceSessionId || preferred,
      log,
    })
    if (proposeWake.ok) {
      try { options.onSession?.(proposeWake.sessionId) } catch { /* ignore */ }
      if (proposeWake.sessionId) induceSessionId = proposeWake.sessionId
      const proposeReply = await waitReply(options.ctx, proposeWake.sessionId, {
        timeoutMs: 90_000,
        isAborted: () => stopped || Boolean(options.isAborted?.()),
      })
      if (proposeReply.ok && proposeReply.text) {
        const parsedScripts = parseScriptProposals(proposeReply.text)
        proposedScripts = parsedScripts.scripts
        await appendCoachLog(options.home, id, {
          kind: 'script',
          summary: parsedScripts.none
            ? 'NONE'
            : `propose:${proposedScripts.length}`,
        })
      }
    }

    const playbook = {
      id,
      goal: savedGoal,
      approach: 'smart',
      strategy: {
        approach: 'smart',
        summary,
        fastPlan,
      },
      understanding: {
        summary,
        fastPlan,
        constraints: mergedConstraints,
        success: '主人对话确认做成了',
      },
      steps: [],
      stats: { coachAttempts: savedAttempts, mode: 'coach' },
      ownerNotes: '',
    }

    const now = new Date().toISOString()
    const pair = await createLearnedAutomationPair(options.home, {
      v: 2,
      id,
      goal: savedGoal,
      teachSessionId: id,
      understanding: {
        summary,
        fastPlan,
        approach: 'smart',
        constraints: mergedConstraints,
        success: '主人对话确认做成了',
        attemptCount: savedAttempts,
      },
      coach: {
        status: 'verified',
        verifiedAt: now,
        attemptCount: savedAttempts,
        lastFailure: null,
      },
      capability: { skillName: null, scripts: [] },
      evidence: [],
      playbook,
      frames: { count: 0, files: [], forLearningOnly: true },
    })
    await promoteCoachLog(options.home, id, id)
    lastPairId = id

    const harness = await registerHarnessAutomation(options.ctx, {
      goal: savedGoal,
      learnedId: id,
      automationId: pair.task.id,
      summary,
      preferredSessionId: preferred,
      scheduleText: [savedGoal, summary, fastPlan].filter(Boolean).join('\n'),
      log,
    })
    await patchLearnedScheduleMeta(options.home, id, {
      scheduleId: harness.scheduleId || null,
      scheduleSessionId: harness.sessionId || null,
      scheduled: Boolean(harness.scheduled),
      timingLabel: harness.timingLabel || null,
      skillName: harness.skillName || null,
    })

    let scriptNote = ''
    const skillName = harness.skillName || null
    if (proposedScripts.length && skillName) {
      let allowScripts = false
      if (options.confirmGate?.ask) {
        const verdict = await options.confirmGate.ask({
          summary: buildScriptsConfirmSummary(proposedScripts, skillName),
          tier: 'L3',
          action: { teach: 'write-scripts', count: proposedScripts.length, skillName },
        })
        allowScripts = Boolean(verdict?.allow)
      }
      if (allowScripts) {
        try {
          const written = await writeCoachScripts(skillName, proposedScripts)
          await rewriteSkillWithScripts({
            skillName,
            goal: savedGoal,
            learnedId: id,
            automationId: pair.task.id,
            summary,
            scripts: written.scripts,
          })
          await patchLearnedCapability(options.home, id, {
            skillName,
            scripts: written.scripts,
          })
          await appendCoachLog(options.home, id, {
            kind: 'script',
            summary: `written:${written.scripts.length}`,
          }, { learned: true })
          scriptNote = `\n已沉淀 ${written.scripts.length} 个脚本块（skills/${skillName}/scripts/），下次优先按需执行。`
        } catch (e) {
          log(`写脚本失败：${e?.message ?? e}`)
          scriptNote = `\n脚本写入失败：${clip(e?.message ?? e, 60)}`
        }
      } else {
        scriptNote = proposedScripts.length
          ? '\n（有可脚本化步骤，未确认写入则只保留文字说明。）'
          : ''
        await appendCoachLog(options.home, id, {
          kind: 'script',
          summary: allowScripts ? 'skip' : 'denied-or-no-gate',
        }, { learned: true })
      }
    }

    await updateTeachMeta(options.home, id, {
      status: 'paired',
      mode: 'coach',
      learnedId: pair.learn.id,
      automationId: pair.task.id,
      scheduleId: harness.scheduleId || null,
      scheduled: Boolean(harness.scheduled),
      scriptCount: proposedScripts.length,
    })

    const notice = buildLearnedChatNotice({ goal: savedGoal, summary, fastPlan, id })
    let bubble = notice
    if (harness.ok && harness.scheduled) {
      bubble += `\n已按「${clip(harness.timingLabel || '定时', 24)}」登记到 Harness。这次不自动再跑。`
    } else if (harness.ok) {
      bubble += '\n未设定运行时间（没说几点就不排程）。这次不自动再跑。'
    } else {
      bubble += `\nHarness：${harness.reason || '未登记'}。这次不自动再跑。`
    }
    bubble += scriptNote
    await appendPetChatMessages(
      [
        { role: 'user', content: `【带教完成】${clip(userText, 80)}` },
        { role: 'assistant', content: bubble },
      ],
      { petId: pet, memoryPath: options.petMemoryPath },
    ).catch((e) => log(`coach：写聊天失败：${e?.message ?? e}`))

    await broadcastToDshPet(bubble, { pet, duration: 18_000 })
    log(`coach：verified ${id}`)
  }

  /**
   * 带教中每一句：模型分流 done/abort/correct/step/open。
   * @param {string} userText
   */
  async function handleCoachUtterance(userText) {
    const text = String(userText || '').trim()
    if (!text) return
    if (!teaching || !sessionId) {
      await broadcastToDshPet('现在不在带教。想教我说「我教你…」。', { pet, duration: 8_000 })
      return
    }
    if (coachBusy) {
      await broadcastToDshPet('上句还在处理，稍等一下…', { pet, duration: 5_000 })
      return
    }
    const epoch = coachEpoch
    const sid = sessionId
    coachBusy = true
    try {
      const preferred = options.getPreferredSessionId?.() ?? null
      const label = await classifyCoachUtterance(options.ctx, text, {
        goal,
        preferredId: preferred,
        wake,
        waitReply,
        log,
      })
      // 分流常要等主会话十几秒；期间若已做成了/放弃/stop，结果作废
      if (!coachStillActive(epoch, sid)) {
        log(`coach：分流过期（${label}），忽略`)
        return
      }
      await appendCoachLog(options.home, sid, {
        kind: 'utterance',
        text,
        label,
      })

      if (label === 'done') {
        await finishCoachVerified(text)
        return
      }
      if (label === 'abort') {
        await finishCoachAbort(text, epoch)
        return
      }
      if (label === 'correct' || label === 'step') {
        if (!coachStillActive(epoch, sid)) {
          log(`coach：${label} 过期，忽略`)
          return
        }
        if (label === 'correct') {
          constraints.push(clip(text, 120))
          constraints = [...new Set(constraints)].slice(0, 12)
        }
        attemptCount += 1
        await appendCoachLog(options.home, sid, {
          kind: label,
          text,
          attemptCount,
        })
        await broadcastToDshPet(
          label === 'correct' ? '收到纠正，我按你说的改这一步…' : '好，我按你这一步来…',
          { pet, duration: 6_000 },
        )
        if (!coachStillActive(epoch, sid)) return
        await wakeCoachRound(text)
        return
      }

      if (!coachStillActive(epoch, sid)) return
      // open（或无法解析回落）：模型认为尚无具体一步 → 不动手
      await appendCoachLog(options.home, sid, {
        kind: 'open',
        text,
        label,
      })
      await broadcastToDshPet(
        `目标仍是「${clip(goal, 36)}」。请再说这一步要我做什么；我不会自己把整件事做完。`,
        { pet, duration: 12_000 },
      )
    } finally {
      coachBusy = false
    }
  }

  /** 兼容旧 teach-end：若仍在带教则当作做成了。 */
  async function stopAndRun() {
    if (!teaching || !sessionId) {
      const ran = await tryRunMatchingPlaybook('再做一次刚才教的')
      if (ran) return
      await sayConclusionToPet('现在不在带教。想教我说「我教你…」；要跑已学会的也可以说。', {
        pet,
        duration: 10_000,
        memoryPath: options.petMemoryPath,
      })
      return
    }
    await handleCoachUtterance('做成了，可以记下来')
  }

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
    const learnMeta = await readLearned(options.home, id).catch(() => null)
    const summary = learnMeta?.understanding?.summary || playbook.strategy?.summary || ''
    const fastPlan = learnMeta?.understanding?.fastPlan || playbook.strategy?.fastPlan || ''
    const snap = String(summary || '').slice(0, 800)

    // S 优先：有 ready 脚本则先按块执行（可 dry-run）
    const scriptCap = learnMeta?.capability?.scripts
    if (Array.isArray(scriptCap) && scriptCap.some((s) => s?.status === 'ready')) {
      await broadcastToDshPet(
        `先按学会的脚本块做「${clip(playbook.goal, 28)}」…`,
        { pet, duration: 8_000 },
      )
      const ran = await runReadyCoachScripts(learnMeta, { dryRunFirst: true, log })
      if (ran.ok) {
        const doneText = `脚本块已跑完：${clip(playbook.goal, 40)}（${ran.results.filter((r) => r.phase === 'run').length} 块）`
        await sayConclusionToPet(doneText, {
          pet,
          duration: 12_000,
          memoryPath: options.petMemoryPath,
        })
        await updateTeachMeta(options.home, id, {
          status: 'done',
          via: 'scripts',
          endedAt: new Date().toISOString(),
        })
        await recordRun(id, {
          via: 'scripts',
          ok: true,
          summary: doneText,
          understandingSnapshot: snap,
        })
        return
      }
      await broadcastToDshPet(
        `脚本块未完全成功（${ran.reason || 'fail'}），改按说明变通…`,
        { pet, duration: 8_000 },
      )
    }
    const glanceSteps = (playbook.steps || []).filter((s) => s.mode === 'glance')
    // 变通：叫醒模型用 glance + 脚本/命令（禁止 act）；不再本地鼠标键盘回放
    const smart = shouldUseSmartRun(playbook, learnMeta)

    if (smart) {
      const preferred = options.getPreferredSessionId?.() ?? null
      const prepared = await prepareSession(options.ctx, {
        preferredId: preferred,
        titleHint: String(playbook.goal || goal || '再做一次').slice(0, 36),
        onSession: options.onSession,
        log,
      })
      if (prepared.fresh && prepared.sessionId) {
        await broadcastToDshPet('已新开干净会话来执行（脚本/命令·标准·low）…', {
          pet,
          duration: 6_000,
        })
      } else if (!prepared.fresh) {
        await broadcastToDshPet('新开会话失败，改用当前会话执行…', {
          pet,
          duration: 6_000,
        })
      }
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
        `按变通思路做「${clip(playbook.goal, 28)}」${fastPlan ? `：${clip(fastPlan, 36)}` : ''}…`,
        { pet, duration: 10_000 },
      )
      const woken = await wake(options.ctx, {
        text: prompt,
        sessionId: prepared.sessionId || undefined,
        preferredId: prepared.sessionId || preferred,
      })
      if (!woken.ok) {
        await broadcastToDshPet(
          `快捷路径没叫醒主会话（${woken.reason || 'unknown'}），我改口述步骤…`,
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
        await broadcastToDshPet('快捷路径这轮没结果，我改口述…', { pet, duration: 8_000 })
      }
    }

    if (glanceSteps.length) {
      const preferred = options.getPreferredSessionId?.() ?? null
      const prepared = await prepareSession(options.ctx, {
        preferredId: preferred,
        titleHint: String(playbook.goal || '看屏执行').slice(0, 36),
        onSession: options.onSession,
        log,
      })
      const remainder = { ...playbook, steps: glanceSteps }
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
            ? '找不到主会话做看屏核对。请打开一个对话再说去做。'
            : `看屏步没叫醒主会话（${why}）。本版本不再回放鼠标键盘。`,
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
          via: 'glance-only',
          endedAt: new Date().toISOString(),
        })
        await recordRun(id, {
          via: 'glance-only',
          ok: true,
          summary: reply.text,
          understandingSnapshot: snap,
        })
        return
      }
    }

    const oral = [
      `本版本不再回放鼠标/键盘。`,
      summary ? `理解：${clip(summary, 100)}` : '',
      fastPlan ? `可参考：${clip(fastPlan, 80)}` : '',
      '请补 Python 脚本块后再说「执行一下」，或按口述自己点。',
    ].filter(Boolean).join(' ')
    await sayConclusionToPet(oral, {
      pet,
      duration: 14_000,
      memoryPath: options.petMemoryPath,
    })
    await updateTeachMeta(options.home, id, {
      status: 'oral-only',
      via: 'oral-no-act',
      endedAt: new Date().toISOString(),
    })
    await recordRun(id, {
      via: 'oral-no-act',
      ok: false,
      summary: oral,
      understandingSnapshot: snap,
    })
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
    const hasGoal = Boolean(String(playbook?.goal || '').trim())
    const hasSteps = Array.isArray(playbook?.steps) && playbook.steps.length > 0
    if (!playbook || (!hasGoal && !hasSteps)) return false

    await broadcastToDshPet(
      `好，执行自动化「${clip(playbook.goal, 36)}」（脚本/命令优先，不点鼠标键盘）…`,
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
      if (teaching) {
        await handleCoachUtterance(msg.content)
        return
      }
      if (isTeachStartIntent(msg.content)) {
        await startTeaching(msg.content)
        return
      }
      if (isTeachEndIntent(msg.content)) {
        await stopAndRun()
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
    if (teaching) endTeachingFlag()
  }

  return {
    start,
    stop,
    tick,
    isTeaching: () => teaching,
    getSessionId: () => sessionId,
    startTeaching,
    handleCoachUtterance,
    stopAndRun,
    tryRunMatchingPlaybook,
    runPlaybook,
    runPlanLocal,
    buildTeachUnderstandPrompt,
    buildTeachGlancePrompt,
  }
}
