/**
 * `act` 工具：策略 →（确认）→ sidecar 输入 → 本地验证 → 审计。
 *
 * @module src/tool-act.js
 */

import { actToolSpec, ACT_TOOL_NAME } from './tool-spec-act.js'
import { isActEnabled } from './settings.js'
import { appendAction } from './audit.js'
import {
  evaluateActPolicy,
  summarizeActForConfirm,
} from './policy.js'
import {
  captureScreenFingerprint,
  compareFingerprints,
  shouldVerifyAction,
} from './verify-act.js'
import { readTeachSecrets } from './teach-store.js'
import { c3MaybeNoopHint } from './c3-task.js'
import { mapImageToScreen, maybeRemapImageCoordsAsScreen } from './coords.js'
import { isSubmitFamily } from './policy.js'

/**
 * 把图内坐标 / 误把缩略图当屏幕坐标 换算成物理像素。
 * @param {object} args
 * @param {import('./coords.js').GlanceMap | null | undefined} map
 */
export function resolveActCoords(args, map) {
  const next = { ...args }
  let remapped = false
  let fromImage = false

  if (next.imageX != null && next.imageY != null && map) {
    const m = mapImageToScreen(next.imageX, next.imageY, map)
    if (m.mapped) {
      next.x = m.x
      next.y = m.y
      fromImage = true
      remapped = true
    }
  } else if (next.x != null && next.y != null && map) {
    const m = maybeRemapImageCoordsAsScreen(next.x, next.y, map)
    if (m.remapped) {
      next.x = m.x
      next.y = m.y
      remapped = true
    }
  }

  if (next.imageX2 != null && next.imageY2 != null && map) {
    const m = mapImageToScreen(next.imageX2, next.imageY2, map)
    if (m.mapped) {
      next.x2 = m.x
      next.y2 = m.y
      remapped = true
    }
  }

  return { args: next, remapped, fromImage }
}

/**
 * 窗口标题 → focus 匹配片段（「小蓝鲸问候 - 豆包」→「豆包」）。
 * @param {string | null | undefined} title
 */
export function focusMatchFromTitle(title) {
  const t = String(title || '').trim()
  if (!t || /dsh-pet|桌宠/i.test(t)) return ''
  const dash = t.lastIndexOf(' - ')
  if (dash > 0 && dash < t.length - 3) {
    return t.slice(dash + 3).trim() || t
  }
  return t
}

/**
 * 确认框/桌宠会抢焦点：点击类动作前尽量把目标窗拉回前台。
 * @param {object[]} actions
 * @param {string | null | undefined} windowTitle
 * @param {boolean} needsRefocus
 */
export function prependFocusIfNeeded(actions, windowTitle, needsRefocus) {
  if (!needsRefocus || !Array.isArray(actions) || !actions.length) return actions
  const kind = String(actions[0]?.kind || '')
  const pointy = ['move', 'click', 'double_click', 'right_click', 'drag', 'type', 'key', 'scroll'].includes(kind)
  if (!pointy) return actions
  const match = focusMatchFromTitle(windowTitle)
  if (!match) return actions
  return [{ kind: 'focus', window: match }, ...actions]
}

/**
 * 确认后组装真实输入序列：focus →（回车前先点回输入框）→ 原动作。
 * 点确认会抢走输入框光标；只 focus 窗口不够，回车发不出去。
 *
 * @param {object[]} actions
 * @param {{
 *   windowTitle?: string | null,
 *   needsRefocus?: boolean,
 *   confirmed?: boolean,
 *   keys?: string,
 *   lastInputClick?: { x: number, y: number, at?: number } | null,
 * }} opts
 */
export function buildGuardedInputActions(actions, opts = {}) {
  let out = prependFocusIfNeeded(actions, opts.windowTitle, Boolean(opts.needsRefocus))
  const kind = String(actions?.[0]?.kind || '')
  const keys = String(opts.keys || '').trim().toLowerCase().replace(/\s+/g, '')
  const isEnter = kind === 'key' && (keys === 'enter' || keys === 'return')
  const click = opts.lastInputClick
  const fresh = click
    && Number.isFinite(Number(click.x))
    && Number.isFinite(Number(click.y))
    && (!click.at || (Date.now() - Number(click.at)) < 180_000)
  if (opts.confirmed && isEnter && fresh) {
    const head = out[0]?.kind === 'focus' ? [out[0]] : []
    const rest = out[0]?.kind === 'focus' ? out.slice(1) : out
    out = [
      ...head,
      { kind: 'click', x: Number(click.x), y: Number(click.y) },
      { kind: 'wait', ms: 120 },
      ...rest,
    ]
  }
  return out
}

function buildActions(args) {
  const action = String(args?.action ?? '').trim().toLowerCase()
  if (!action) {
    throw Object.assign(new Error('缺少 action'), { code: 'BAD_REQUEST' })
  }

  const base = { kind: action }
  if (args?.x != null) base.x = Number(args.x)
  if (args?.y != null) base.y = Number(args.y)
  if (args?.x2 != null) base.x2 = Number(args.x2)
  if (args?.y2 != null) base.y2 = Number(args.y2)
  if (args?.text != null) base.text = String(args.text)
  if (args?.keys != null) base.keys = String(args.keys)
  if (args?.button != null) base.button = String(args.button)
  if (args?.ms != null) base.ms = Number(args.ms)
  if (args?.window != null) base.window = String(args.window)
  if (args?.delta != null) base.delta = Number(args.delta)
  if (action === 'double_click') base.kind = 'double_click'
  if (action === 'right_click') base.kind = 'right_click'
  return [base]
}

function auditArgs(args) {
  const out = { action: args?.action }
  for (const k of ['x', 'y', 'x2', 'y2', 'button', 'keys', 'window', 'ms', 'delta']) {
    if (args?.[k] != null) out[k] = args[k]
  }
  if (args?.secretRef) {
    out.secretRef = String(args.secretRef)
    out.text = '[local-secret]'
  } else if (args?.text != null) {
    const t = String(args.text)
    out.text = t.length > 80 ? `${t.slice(0, 80)}…` : t
  }
  if (args?.reason != null) out.reason = String(args.reason).slice(0, 200)
  return out
}

/**
 * 宿主工具输出必须 lossless JSON：对象里的 undefined / NaN / Infinity 都会被拒。
 * @param {object} value
 */
export function asToolOutput(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_k, v) => (
    typeof v === 'number' && !Number.isFinite(v) ? null : v
  )))
}

function pickScreen(raw, fallback = null) {
  if (!raw || typeof raw !== 'object') return fallback
  const w = Number(raw.w ?? raw.width) || 0
  const h = Number(raw.h ?? raw.height) || 0
  if (w <= 0 || h <= 0) return fallback
  const out = { w, h }
  const v = raw.virtual
  if (v && Number(v.w) > 0 && Number(v.h) > 0) {
    out.virtual = {
      x: Number(v.x) || 0,
      y: Number(v.y) || 0,
      w: Number(v.w),
      h: Number(v.h),
    }
  } else if (fallback?.virtual) {
    out.virtual = fallback.virtual
  }
  return out
}

/**
 * @param {{
 *   home: string,
 *   log?: (m: string) => void,
 *   sidecar?: { call: Function, isAlive?: Function } | null,
 *   isArmed?: () => boolean,
 *   onActing?: () => void,
 *   onIdle?: () => void,
 *   getWindowTitle?: () => string | null,
 *   getScreen?: () => { w?: number, h?: number } | null,
 *   budget?: object,
 *   confirmGate?: { ask: Function },
 *   rememberedConfirms?: Set<string>,
 *   turnKey?: () => string,
 *   denyTitles?: string[],
 *   onConfirmAsk?: (summary: string) => void | Promise<void>,
 *   onPolicyDeny?: (info: { code?: string, reason?: string, userBubble?: string, tier?: string }) => void | Promise<void>,
 *   getLastGlanceMap?: () => import('./coords.js').GlanceMap | null,
 *   getLastInputClick?: () => { x: number, y: number, at?: number } | null,
 *   onInputClick?: (p: { x: number, y: number, at: number, reason?: string }) => void,
 * }} options
 */
export function createActTool(options = {}) {
  const log = options.log ?? (() => {})
  const remembered = options.rememberedConfirms ?? new Set()

  return {
    ...actToolSpec(),
    async execute(args, exec) {
      const t0 = Date.now()
      let tier = null
      let confirmed = null
      let beforeHash = null
      let afterHash = null
      let maybeNoop = false
      let windowTitle = null
      let screen = null
      let coordRemapped = false

      const finishAudit = async (result) => {
        const safe = asToolOutput(result)
        try {
          await appendAction(options.home, {
            action: args?.action,
            args: auditArgs(args),
            tier,
            confirmed,
            ok: Boolean(safe?.meta?.ok),
            code: safe?.meta?.code ?? null,
            ms: Date.now() - t0,
            screen,
            window: windowTitle,
            before: beforeHash,
            after: afterHash,
            maybeNoop,
            reason: args?.reason ? String(args.reason).slice(0, 200) : undefined,
          })
        } catch (e) {
          log(`审计写入失败：${e?.message ?? e}`)
        }
        return safe
      }

      if (!isActEnabled(options.home)) {
        return finishAudit({
          text: 'act 未启用。在右键「更多」打开「允许动手」，或设 settings.actEnabled / DSH_PET_ENHANCE_ACT=1。',
          meta: { ok: false, code: 'ACT_DISABLED' },
        })
      }
      if (options.isArmed && !options.isArmed()) {
        return finishAudit({
          text: '用户叫停了本次操作（armed=false）。不要重试。',
          meta: { ok: false, code: 'DISARMED', aborted: true },
        })
      }
      const sidecar = options.sidecar
      if (!sidecar?.isAlive?.() || typeof sidecar.call !== 'function') {
        return finishAudit({
          text: '输入需要 Python sidecar，当前不可用。',
          meta: { ok: false, code: 'SIDECAR_DOWN' },
        })
      }

      // 坐标：优先 imageX/imageY；若模型把缩略图坐标当屏幕坐标也自动换算。
      const glanceMap = options.getLastGlanceMap?.() ?? null
      const resolved = resolveActCoords(args, glanceMap)
      args = resolved.args
      coordRemapped = resolved.remapped
      if (coordRemapped) {
        log(`act 坐标已换算 → (${args.x},${args.y})${resolved.fromImage ? ' [imageX/Y]' : ' [auto]'}`)
      }

      // 教学敏感输入：secretRef = "<sessionId>/step:N"，正文只从本地 secrets 读，不进模型上下文。
      if (args?.secretRef && (args.action === 'type' || !args.action)) {
        const rawRef = String(args.secretRef)
        const slash = rawRef.indexOf('/')
        if (slash <= 0) {
          return finishAudit({
            text: 'secretRef 格式不对（应为 sessionId/step:N）。',
            meta: { ok: false, code: 'BAD_SECRET_REF' },
          })
        }
        const sid = rawRef.slice(0, slash)
        const key = rawRef.slice(slash + 1)
        const secrets = await readTeachSecrets(options.home, sid)
        const secretText = secrets?.[key]
        if (typeof secretText !== 'string') {
          return finishAudit({
            text: '本地找不到该教学敏感输入，无法代打。',
            meta: { ok: false, code: 'SECRET_MISSING' },
          })
        }
        args = { ...args, action: 'type', text: secretText, reason: args.reason || '教学敏感输入（本地）' }
      }

      let actions
      try {
        actions = buildActions(args)
      } catch (e) {
        return finishAudit({
          text: `参数不对：${e?.message ?? e}`,
          meta: { ok: false, code: 'BAD_REQUEST' },
        })
      }
      if (actions.length !== 1) {
        return finishAudit({
          text: '一次 act 只允许一个动作。',
          meta: { ok: false, code: 'BAD_REQUEST' },
        })
      }

      windowTitle = options.getWindowTitle?.() ?? null
      screen = pickScreen(options.getScreen?.() ?? sidecar.getHello?.()?.screen ?? null)
      /** @type {string[]} */
      let windowTitles = windowTitle ? [windowTitle] : []

      // 前台窗 + 点击坐标下方窗（桌宠常抢前台，黑名单必须看真下的窗）
      try {
        const statsFields = {}
        if (args?.x != null && args?.y != null) {
          statsFields.x = Number(args.x)
          statsFields.y = Number(args.y)
        }
        const stats = await sidecar.call('stats', statsFields, 2_000)
        if (stats?.ok) {
          if (stats.active?.title) {
            windowTitle = String(stats.active.title)
            windowTitles.push(windowTitle)
          }
          if (stats.atPoint?.title) {
            windowTitles.push(String(stats.atPoint.title))
            // 审计优先记点下方的非桌宠窗
            if (!/dsh-pet|桌宠/i.test(stats.atPoint.title)) {
              windowTitle = String(stats.atPoint.title)
            }
          }
          // 必须保留 virtual，否则多屏负坐标会被误判越界
          screen = pickScreen(stats.screen, screen)
        }
      } catch { /* 策略仍可用缓存 */ }

      const teachReplay = Boolean(args?._teachReplay)
      if ('_teachReplay' in (args || {})) {
        const { _teachReplay: _drop, ...rest } = args
        args = rest
      }

      const decision = evaluateActPolicy({
        args,
        windowTitle,
        windowTitles,
        screen,
        denyTitles: options.denyTitles,
        budget: options.budget,
        turnKey: options.turnKey?.() ?? 'default',
        remembered,
        teachReplay,
      })
      tier = decision.tier
      if (decision.windowTitle) windowTitle = decision.windowTitle

      if (!decision.ok) {
        try {
          await options.onPolicyDeny?.({
            code: decision.code,
            reason: decision.reason,
            userBubble: decision.userBubble,
            tier,
          })
        } catch { /* ignore */ }
        return finishAudit({
          text: decision.reason || '策略拒绝',
          meta: {
            ok: false,
            code: decision.code,
            tier,
            budget: decision.budget,
            windowTitle: decision.windowTitle ?? windowTitle,
          },
        })
      }

      if (decision.needsConfirm) {
        if (!options.confirmGate?.ask) {
          return finishAudit({
            text: '该动作需要确认，但确认闸门未就绪。',
            meta: { ok: false, code: 'CONFIRM_UNAVAILABLE', tier },
          })
        }
        const summary = summarizeActForConfirm(args, tier)
        try { await options.onConfirmAsk?.(summary) } catch { /* ignore */ }
        const verdict = await options.confirmGate.ask({
          summary,
          tier,
          action: auditArgs(args),
        })
        confirmed = Boolean(verdict.allow)
        if (!verdict.allow) {
          return finishAudit({
            text: verdict.via === 'timeout'
              ? '确认超时，视为拒绝。不要换方式再试。'
              : '用户点了「不要」。任务到此结束，不要换方式再试。',
            meta: {
              ok: false,
              code: verdict.via === 'timeout' ? 'CONFIRM_TIMEOUT' : 'CONFIRM_DENIED',
              tier,
              confirmed: false,
              aborted: true,
            },
          })
        }
        if (tier === 'L2' && decision.confirmSig) {
          remembered.add(decision.confirmSig)
        }
      } else if (tier === 'L2' || tier === 'L3') {
        confirmed = true // 本任务内已记住
      }

      try { options.onActing?.() } catch { /* ignore */ }

      try {
        if (exec?.signal?.aborted || (options.isArmed && !options.isArmed())) {
          return finishAudit({
            text: '用户叫停了本次操作。不要重试。',
            meta: { ok: false, aborted: true, code: 'ABORTED', tier, confirmed },
          })
        }

        const kind = actions[0].kind
        // 确认框/桌宠抢焦点后：先 focus；若是回车发送再点回输入框恢复光标
        const focusHint = args?.window
          || glanceMap?.windowTitle
          || windowTitle
        const skipFocus = kind === 'focus'
          || (kind === 'key' && /^(win|meta|cmd)(\+|\$|$)/i.test(String(args?.keys || '').trim()))
        const needsRefocus = !skipFocus && (
          Boolean(confirmed)
          || Boolean(args?.window)
          || Boolean(glanceMap?.windowTitle)
        )
        const actionsOut = buildGuardedInputActions(actions, {
          windowTitle: focusHint,
          needsRefocus,
          confirmed: Boolean(confirmed),
          keys: args?.keys,
          lastInputClick: options.getLastInputClick?.() ?? null,
        })

        if (shouldVerifyAction(kind)) {
          beforeHash = await captureScreenFingerprint(sidecar)
        }

        const resp = await sidecar.call('input', { actions: actionsOut }, 120_000)
        if (resp?.aborted || resp?.error?.code === 'FAILSAFE' || resp?.cause === 'failsafe') {
          return finishAudit({
            text: '用户把光标甩到左上角，已急停。不要重试。',
            meta: {
              ok: false,
              aborted: true,
              code: 'FAILSAFE',
              tier,
              confirmed,
              done: resp?.done ?? [],
              cursor: resp?.cursor,
              ms: Date.now() - t0,
            },
          })
        }
        if (resp?.aborted || resp?.error?.code === 'ABORTED') {
          return finishAudit({
            text: '用户叫停了本次操作。不要重试。',
            meta: {
              ok: false,
              aborted: true,
              code: 'ABORTED',
              tier,
              confirmed,
              done: resp?.done ?? [],
              ms: Date.now() - t0,
            },
          })
        }
        if (!resp?.ok) {
          const msg = resp?.error?.message || '输入失败'
          log(`act 失败：${resp?.error?.code || ''} ${msg}`)
          return finishAudit({
            text: msg,
            meta: {
              ok: false,
              code: resp?.error?.code || 'INPUT_FAILED',
              tier,
              confirmed,
              ms: Date.now() - t0,
            },
          })
        }

        if (shouldVerifyAction(kind)) {
          afterHash = await captureScreenFingerprint(sidecar)
          const cmp = compareFingerprints(beforeHash, afterHash)
          maybeNoop = cmp.maybeNoop
          beforeHash = cmp.before
          afterHash = cmp.after
        }

        // 记住非「发送」类点击，供确认后回车前点回输入框
        if (
          (kind === 'click' || kind === 'double_click')
          && args?.x != null && args?.y != null
          && !isSubmitFamily(args)
        ) {
          try {
            options.onInputClick?.({
              x: Number(args.x),
              y: Number(args.y),
              at: Date.now(),
              reason: String(args?.reason || '').slice(0, 80),
            })
          } catch { /* ignore */ }
        }

        const cur = resp.cursor ? `${resp.cursor.x},${resp.cursor.y}` : '?'
        const warn = maybeNoop ? ` ${c3MaybeNoopHint()}` : ''
        const remapNote = coordRemapped
          ? `（已把图内坐标换算为屏幕 (${args.x},${args.y})）`
          : ''
        return finishAudit({
          text: `已执行 ${kind}（${Date.now() - t0}ms），光标现在 (${cur})。${remapNote}${warn}`,
          meta: {
            ok: true,
            action: kind,
            tier,
            confirmed,
            done: resp.done,
            cursor: resp.cursor,
            dryRun: Boolean(resp.dryRun),
            ms: Date.now() - t0,
            maybeNoop,
            before: beforeHash,
            after: afterHash,
            budget: decision.budget,
            remapped: coordRemapped,
            x: args?.x,
            y: args?.y,
            reason: args?.reason ? String(args.reason).slice(0, 200) : undefined,
          },
        })
      } catch (e) {
        log(`act 异常：${e?.message ?? e}`)
        return finishAudit({
          text: `输入异常：${e?.message ?? e}`,
          meta: { ok: false, code: e?.code || 'INPUT_FAILED', tier, confirmed },
        })
      } finally {
        try { options.onIdle?.() } catch { /* ignore */ }
      }
    },
  }
}

export { ACT_TOOL_NAME }
