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

      const finishAudit = async (result) => {
        try {
          await appendAction(options.home, {
            action: args?.action,
            args: auditArgs(args),
            tier,
            confirmed,
            ok: Boolean(result?.meta?.ok),
            code: result?.meta?.code ?? null,
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
        return result
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
      screen = options.getScreen?.() ?? sidecar.getHello?.()?.screen ?? null
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
          if (stats.screen?.w && stats.screen?.h) {
            screen = { w: stats.screen.w, h: stats.screen.h }
          }
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
        if (shouldVerifyAction(kind)) {
          beforeHash = await captureScreenFingerprint(sidecar)
        }

        const resp = await sidecar.call('input', { actions }, 120_000)
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

        const cur = resp.cursor ? `${resp.cursor.x},${resp.cursor.y}` : '?'
        const warn = maybeNoop ? ' 画面几乎没变，可能没生效——请先 glance 再决定是否重试一次。' : ''
        return finishAudit({
          text: `已执行 ${kind}（${Date.now() - t0}ms），光标现在 (${cur})。${warn}`,
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
