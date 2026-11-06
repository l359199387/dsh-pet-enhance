/**
 * act 策略引擎：分级、窗口黑名单、坐标校验、每轮动作预算。
 *
 * 规则口径见 docs/07-safety.md。拿不准就往高一级归，永不往低猜。
 *
 * @module src/policy.js
 */

export const MAX_ACTIONS_PER_TURN = 20
export const CONFIRM_TIMEOUT_MS = 60_000

/** 07 §7：可读不可点。 */
export const DENY_TITLE_RES = [
  /1password|bitwarden|keepass|lastpass|密码本|密码|口令|credential|password|passwd/i,
  /bank|银行|支付|alipay|微信支付|paypal/i,
  /uac|用户账户控制|windows\s*安全|consent\.exe/i,
]

/** 桌宠自己的窗标题：不当成「用户目标窗」来过黑名单。 */
export function isPetChromeTitle(title) {
  return /dsh-pet|桌宠/i.test(String(title ?? ''))
}

/**
 * 合并前台窗 + 点击点下方窗；优先用非桌宠标题做黑名单判断。
 * @param {...(string | null | undefined)} titles
 * @returns {string[]}
 */
export function policyWindowTitles(...titles) {
  const list = []
  for (const t of titles) {
    const s = String(t ?? '').trim()
    if (s && !list.includes(s)) list.push(s)
  }
  const nonPet = list.filter((t) => !isPetChromeTitle(t))
  return nonPet.length ? nonPet : list
}

const SUBMIT_REASON_RE = /保存|确定|确认|提交|发送|发布|关闭|删除|卸载|支付|转账|登录|登陆|ok|save|submit|send|delete|close/i

const F_REASON_RE = /入侵|窃取|凭据|cookie|密钥|绕过|验证码|drm|挖矿|诈骗|钓鱼|骚扰|破解|勒索|别让.*(知道|发现)/i

/**
 * @param {string | null | undefined} title
 * @param {string[]} [extraDeny]
 */
export function isDeniedWindow(title, extraDeny = []) {
  const t = String(title ?? '').trim()
  if (!t) return false
  if (DENY_TITLE_RES.some((re) => re.test(t))) return true
  for (const raw of extraDeny) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    if (t.toLowerCase().includes(s.toLowerCase())) return true
  }
  return false
}

/**
 * @param {string} keys
 * @returns {'F'|'L3'|'L2'|'L1'|null}
 */
export function classifyKeys(keys) {
  const k = String(keys ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!k) return null
  if (k === 'win+l' || k === 'meta+l' || k === 'ctrl+alt+del' || k === 'ctrl+alt+delete') return 'F'
  if (k === 'win+r' || k === 'meta+r' || k === 'win+x' || k === 'meta+x') return 'L3'
  if (k === 'alt+f4') return 'L2'
  if (k === 'ctrl+s' || k === 'meta+s' || k === 'enter' || k === 'return') return 'L2'
  return 'L1'
}

/**
 * @param {{ action?: string, keys?: string, reason?: string, text?: string }} args
 * @returns {'L0'|'L1'|'L2'|'L3'|'F'}
 */
export function classifyAction(args = {}) {
  const action = String(args.action ?? '').trim().toLowerCase()
  const reason = String(args.reason ?? '')
  const text = String(args.text ?? '')

  if (F_REASON_RE.test(reason) || F_REASON_RE.test(text)) return 'F'

  if (action === 'screen' || action === 'wait') return 'L0'
  if (action === 'move' || action === 'scroll' || action === 'focus') return 'L1'
  if (action === 'drag' || action === 'type') {
    return SUBMIT_REASON_RE.test(reason) ? 'L2' : 'L1'
  }
  if (action === 'key') {
    const tier = classifyKeys(args.keys)
    if (tier === 'F') return 'F'
    if (tier === 'L3' || tier === 'L2') return tier
    return SUBMIT_REASON_RE.test(reason) ? 'L2' : 'L1'
  }
  if (action === 'click' || action === 'double_click' || action === 'right_click') {
    return SUBMIT_REASON_RE.test(reason) ? 'L2' : 'L1'
  }
  // 未知动作：往高归
  return 'L2'
}

/**
 * @param {number | null | undefined} x
 * @param {number | null | undefined} y
 * @param {{ w?: number, h?: number } | null | undefined} screen
 */
export function validateCoords(x, y, screen) {
  if (x == null && y == null) return { ok: true }
  if (!screen?.w || !screen?.h) return { ok: true } // 尚无屏幕信息时不挡（sidecar 会再校验）
  const xx = Number(x)
  const yy = Number(y)
  if (!Number.isFinite(xx) || !Number.isFinite(yy)) {
    return { ok: false, code: 'BAD_COORDS', reason: '坐标不是有效数字' }
  }
  if (xx < 0 || yy < 0 || xx >= screen.w || yy >= screen.h) {
    return {
      ok: false,
      code: 'COORDS_OUT_OF_SCREEN',
      reason: `坐标 (${xx}, ${yy}) 超出屏幕 ${screen.w}×${screen.h}`,
    }
  }
  return { ok: true }
}

/**
 * @param {{ x?: number, y?: number, x2?: number, y2?: number, action?: string }} args
 * @param {{ w?: number, h?: number } | null | undefined} screen
 */
export function validateActionCoords(args, screen) {
  const action = String(args?.action ?? '').toLowerCase()
  const needs = ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll'].includes(action)
  if (!needs) return { ok: true }
  const a = validateCoords(args.x, args.y, screen)
  if (!a.ok) return a
  if (action === 'drag') {
    return validateCoords(args.x2, args.y2, screen)
  }
  return { ok: true }
}

/**
 * 生成本任务内「同类已确认」签名（L2 rememberWithinTask）。
 * @param {{ action?: string, keys?: string, reason?: string }} args
 * @param {string} tier
 */
export function confirmSignature(args, tier) {
  const action = String(args?.action ?? '').toLowerCase()
  const keys = String(args?.keys ?? '').toLowerCase()
  const reasonClass = SUBMIT_REASON_RE.test(String(args?.reason ?? '')) ? 'submit' : 'plain'
  return `${tier}|${action}|${keys}|${reasonClass}`
}

/**
 * @param {{ max?: number }} [options]
 */
export function createActionBudget(options = {}) {
  const max = Number(options.max) > 0 ? Number(options.max) : MAX_ACTIONS_PER_TURN
  let turnKey = null
  let count = 0

  return {
    get max() { return max },
    get count() { return count },
    get turnKey() { return turnKey },
    /**
     * @param {string} [key]
     * @returns {{ ok: boolean, count: number, max: number, code?: string, reason?: string }}
     */
    consume(key = 'default') {
      const k = String(key || 'default')
      if (k !== turnKey) {
        turnKey = k
        count = 0
      }
      count += 1
      if (count > max) {
        return {
          ok: false,
          count,
          max,
          code: 'BUDGET_EXCEEDED',
          reason: `本轮动作已达上限（${max}）。请开新任务或说明要继续。`,
        }
      }
      return { ok: true, count, max }
    },
    reset() {
      turnKey = null
      count = 0
    },
  }
}

/**
 * 一次 act 进管线前的硬判断（不含确认等待）。
 *
 * @param {{
 *   args: object,
 *   windowTitle?: string | null,
 *   screen?: { w?: number, h?: number } | null,
 *   denyTitles?: string[],
 *   budget?: ReturnType<typeof createActionBudget>,
 *   turnKey?: string,
 *   remembered?: Set<string>,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   tier: string,
 *   code?: string,
 *   reason?: string,
 *   needsConfirm: boolean,
 *   confirmSig?: string,
 *   budget?: { count: number, max: number },
 * }}
 */
export function evaluateActPolicy(input) {
  const args = input.args ?? {}
  const tier = classifyAction(args)

  if (tier === 'F') {
    return {
      ok: false,
      tier,
      needsConfirm: false,
      code: 'FORBIDDEN',
      reason: '这个我不能做：属于禁止类操作。',
    }
  }

  const titles = policyWindowTitles(
    ...(Array.isArray(input.windowTitles) ? input.windowTitles : []),
    input.windowTitle,
  )
  const deniedTitle = titles.find((t) => isDeniedWindow(t, input.denyTitles))
  if (deniedTitle) {
    return {
      ok: false,
      tier,
      needsConfirm: false,
      code: 'DENIED_WINDOW',
      reason: `窗口「${String(deniedTitle).slice(0, 60)}」在黑名单里：可以看，不能点、不能打字。`,
      windowTitle: deniedTitle,
    }
  }

  const coords = validateActionCoords(args, input.screen)
  if (!coords.ok) {
    return { ok: false, tier, needsConfirm: false, code: coords.code, reason: coords.reason }
  }

  let budgetInfo
  if (input.budget) {
    const b = input.budget.consume(input.turnKey)
    budgetInfo = { count: b.count, max: b.max }
    if (!b.ok) {
      return {
        ok: false,
        tier,
        needsConfirm: false,
        code: b.code,
        reason: b.reason,
        budget: budgetInfo,
      }
    }
  }

  const needsConfirm = tier === 'L2' || tier === 'L3'
  const confirmSig = needsConfirm ? confirmSignature(args, tier) : undefined
  if (needsConfirm && tier === 'L2' && confirmSig && input.remembered?.has(confirmSig)) {
    return { ok: true, tier, needsConfirm: false, confirmSig, budget: budgetInfo }
  }

  return { ok: true, tier, needsConfirm, confirmSig, budget: budgetInfo }
}

/**
 * 给确认气泡用的人话摘要（具体动作，不经模型转述）。
 * @param {object} args
 * @param {string} tier
 */
export function summarizeActForConfirm(args, tier) {
  const action = String(args?.action ?? '').toLowerCase()
  const reason = args?.reason ? String(args.reason).slice(0, 80) : ''
  let core = action
  if (action === 'click' || action === 'double_click' || action === 'right_click') {
    core = `${action} (${args.x}, ${args.y})`
  } else if (action === 'type') {
    const t = String(args.text ?? '').slice(0, 40)
    core = `输入「${t}${String(args.text ?? '').length > 40 ? '…' : ''}」`
  } else if (action === 'key') {
    core = `按键 ${args.keys}`
  } else if (action === 'drag') {
    core = `拖拽 (${args.x},${args.y}) → (${args.x2},${args.y2})`
  } else if (action === 'move') {
    core = `移动光标到 (${args.x}, ${args.y})`
  }
  const head = tier === 'L3' ? '【危险·请逐次确认】' : '【需确认】'
  return reason ? `${head} ${core} — ${reason}` : `${head} ${core}`
}
