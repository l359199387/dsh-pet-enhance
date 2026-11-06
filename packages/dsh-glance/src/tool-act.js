/**
 * `act` 工具：让 sidecar 执行一次输入动作。
 *
 * C1：只做开关检查 + armed + sidecar；分级/确认/审计是 C2。
 * 默认关闭（settings.actEnabled 或 DSH_GLANCE_ACT=1）。
 *
 * @module src/tool-act.js
 */

import { actToolSpec, ACT_TOOL_NAME } from './tool-spec-act.js'
import { isActEnabled } from './settings.js'

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

/**
 * @param {{
 *   home: string,
 *   log?: (m: string) => void,
 *   sidecar?: { call: Function, isAlive?: Function } | null,
 *   isArmed?: () => boolean,
 *   onActing?: () => void,
 *   onIdle?: () => void,
 * }} options
 */
export function createActTool(options = {}) {
  const log = options.log ?? (() => {})
  return {
    ...actToolSpec(),
    async execute(args, exec) {
      if (!isActEnabled(options.home)) {
        return {
          text: 'act 未启用。在 ~/.dsh/glance/settings.json 设 "actEnabled": true，或设环境变量 DSH_GLANCE_ACT=1 后重启。',
          meta: { ok: false, code: 'ACT_DISABLED' },
        }
      }
      if (options.isArmed && !options.isArmed()) {
        return {
          text: '已急停（armed=false）。把宠物设回 idle 或重启后再试；不要自动重试。',
          meta: { ok: false, code: 'DISARMED', aborted: true },
        }
      }
      const sidecar = options.sidecar
      if (!sidecar?.isAlive?.() || typeof sidecar.call !== 'function') {
        return {
          text: '输入需要 Python sidecar，当前不可用。',
          meta: { ok: false, code: 'SIDECAR_DOWN' },
        }
      }

      let actions
      try {
        actions = buildActions(args)
      } catch (e) {
        return { text: `参数不对：${e?.message ?? e}`, meta: { ok: false, code: 'BAD_REQUEST' } }
      }

      // 硬约束 11：一次 act 只带一个动作（不排队多坐标串）。
      if (actions.length !== 1) {
        return { text: '一次 act 只允许一个动作。', meta: { ok: false, code: 'BAD_REQUEST' } }
      }

      try { options.onActing?.() } catch { /* ignore */ }

      const t0 = Date.now()
      try {
        if (exec?.signal?.aborted) {
          return { text: '用户取消了本次操作。', meta: { ok: false, aborted: true, code: 'ABORTED' } }
        }
        const resp = await sidecar.call('input', { actions }, 120_000)
        if (resp?.aborted || resp?.error?.code === 'FAILSAFE' || resp?.cause === 'failsafe') {
          return {
            text: '用户把光标甩到左上角，已急停。不要重试。',
            meta: {
              ok: false,
              aborted: true,
              code: 'FAILSAFE',
              done: resp?.done ?? [],
              cursor: resp?.cursor,
              ms: Date.now() - t0,
            },
          }
        }
        if (resp?.aborted || resp?.error?.code === 'ABORTED') {
          return {
            text: '用户叫停了本次操作。不要重试。',
            meta: { ok: false, aborted: true, code: 'ABORTED', done: resp?.done ?? [], ms: Date.now() - t0 },
          }
        }
        if (!resp?.ok) {
          const msg = resp?.error?.message || '输入失败'
          log(`act 失败：${resp?.error?.code || ''} ${msg}`)
          return {
            text: msg,
            meta: { ok: false, code: resp?.error?.code || 'INPUT_FAILED', ms: Date.now() - t0 },
          }
        }

        const kind = actions[0].kind
        const cur = resp.cursor ? `${resp.cursor.x},${resp.cursor.y}` : '?'
        return {
          text: `已执行 ${kind}（${Date.now() - t0}ms），光标现在 (${cur})。`,
          meta: {
            ok: true,
            action: kind,
            done: resp.done,
            cursor: resp.cursor,
            dryRun: Boolean(resp.dryRun),
            ms: Date.now() - t0,
            reason: args?.reason ? String(args.reason).slice(0, 200) : undefined,
          },
        }
      } catch (e) {
        log(`act 异常：${e?.message ?? e}`)
        return { text: `输入异常：${e?.message ?? e}`, meta: { ok: false, code: e?.code || 'INPUT_FAILED' } }
      } finally {
        try { options.onIdle?.() } catch { /* ignore */ }
      }
    },
  }
}

export { ACT_TOOL_NAME }
