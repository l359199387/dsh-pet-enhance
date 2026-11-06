/**
 * 与已安装的 `dsh-pet` 互操作（不拷贝其素材）。
 *
 * dsh-pet 动画/形象是 CC BY-NC-SA 4.0，禁止商用、禁止塞进本仓库。
 * 合法做法：用户自己装 dsh-pet，我们调 `/dsh-pet-7340/*` 让它开口/切状态。
 *
 * Host 侧必须用绝对 origin（`webServer.getOrigin()` / `DSH_WEB_URL`）；
 * Node 的 `fetch('/dsh-pet-7340/…')` 会直接 Failed to parse URL。
 *
 * @module src/dsh-pet.js
 */

export const DSH_PET_PREFIX = '/dsh-pet-7340'
export const MENU_OWNER = 'dsh-pet-enhance'
export const MENU_STOP = '小蓝鲸急停'
export const MENU_LIVE_ON = '实时看屏幕 · 开'
export const MENU_LIVE_OFF = '实时看屏幕 · 关'
export const MENU_ACT_ON = '允许动手 · 开'
export const MENU_ACT_OFF = '允许动手 · 关'
export const MENU_CONFIRM_YES = '确认动作 · 好'
export const MENU_CONFIRM_NO = '确认动作 · 不要'
/** 动作类接口必填；any = 网页/桌面都能收到。 */
export const PET_SURFACE = 'any'

/** 右键开关文案：开/关两态（dsh-pet 菜单没有原生勾选）。 */
export function liveWatchMenuLabel(enabled) {
  return enabled ? MENU_LIVE_ON : MENU_LIVE_OFF
}

export function actEnabledMenuLabel(enabled) {
  return enabled ? MENU_ACT_ON : MENU_ACT_OFF
}

export function glanceMenuLabels(liveWatchEnabled, actEnabled = false, pendingConfirm = false) {
  const labels = [
    liveWatchMenuLabel(liveWatchEnabled),
    actEnabledMenuLabel(actEnabled),
    MENU_STOP,
  ]
  if (pendingConfirm) {
    labels.push(MENU_CONFIRM_YES, MENU_CONFIRM_NO)
  }
  return labels
}

/** Host 装配期写入；浏览器半身可以继续走相对路径（base 为空）。 */
let defaultBaseUrl = ''

export function setDshPetBaseUrl(url) {
  defaultBaseUrl = String(url ?? '').replace(/\/$/, '')
  return defaultBaseUrl
}

export function getDshPetBaseUrl() {
  return defaultBaseUrl
}

/**
 * 从 webServer / 环境变量解析 DSH HTTP 源。
 * @param {{ getOrigin?: () => string, port?: number } | null | undefined} webServer
 */
export function resolveDshOrigin(webServer) {
  const fromEnv = String(process.env.DSH_WEB_URL || process.env.DSH_ORIGIN || '').trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')

  if (webServer && typeof webServer.getOrigin === 'function') {
    try {
      const origin = String(webServer.getOrigin() || '').replace(/\/$/, '')
      if (origin) return origin
    } catch {
      // 带 zone 的 IPv6 等会抛，落到 port 兜底
    }
  }

  const port = webServer?.port
  if (typeof port === 'number' && port > 0) {
    return `http://127.0.0.1:${port}`
  }
  return ''
}

function withSurface(path, surface = PET_SURFACE) {
  const raw = String(path || '')
  const join = raw.includes('?') ? '&' : '?'
  if (/[?&]surface=/.test(raw)) return raw
  return `${raw}${join}surface=${encodeURIComponent(surface)}`
}

/**
 * 在 dsh-pet 右键「更多」里挂：实时看屏幕 / 允许动手 / 急停。
 * @param {{ liveWatch?: boolean, actEnabled?: boolean, target?: string } & object} [options]
 */
export async function registerGlanceMenu(options = {}) {
  const {
    liveWatch = false,
    actEnabled = false,
    pendingConfirm = false,
    target = 'both',
    ...rest
  } = options
  return callDshPet('/menu/item', {
    method: 'POST',
    body: {
      owner: MENU_OWNER,
      labels: glanceMenuLabels(liveWatch, actEnabled, pendingConfirm),
      target,
    },
    ...rest,
  })
}

export async function clearGlanceMenu(options = {}) {
  return callDshPet(`/menu/item?owner=${encodeURIComponent(MENU_OWNER)}`, {
    method: 'DELETE',
    ...options,
  })
}

/** 跟 dsh-pet 聊一句（可附图）：走它自己的对话与气泡。 */
export async function chatWithDshPet(text, { pet = 'main', attachment, surface = PET_SURFACE, ...options } = {}) {
  const body = { text: String(text ?? '') }
  if (attachment) body.attachment = attachment
  return callDshPet(withSurface(`/chat?pet=${encodeURIComponent(pet)}`, surface), {
    method: 'POST',
    body,
    timeoutMs: 120_000,
    ...options,
  })
}

/**
 * 第三方投喂气泡。无锁时可直接投；有人占用时必须带 lock。
 * @param {string} text
 * @param {{ pet?: string, lockId?: string, duration?: number, surface?: string }} [opts]
 */
export async function broadcastToDshPet(text, { pet = 'main', lockId, duration = 12_000, surface = PET_SURFACE, ...options } = {}) {
  let path = withSurface(`/broadcast?pet=${encodeURIComponent(pet)}`, surface)
  if (lockId) path += `&lock=${encodeURIComponent(lockId)}`
  return callDshPet(path, {
    method: 'POST',
    body: { text: String(text ?? ''), duration, anim: true },
    timeoutMs: 8_000,
    ...options,
  })
}

export async function acquirePetLock(pet = 'main', { surface = PET_SURFACE, ...options } = {}) {
  return callDshPet(withSurface(`/lock?pet=${encodeURIComponent(pet)}`, surface), {
    method: 'POST',
    body: {},
    timeoutMs: 5_000,
    ...options,
  })
}

export async function releasePetLock(pet = 'main', lockId, options = {}) {
  return callDshPet(`/lock/release?pet=${encodeURIComponent(pet)}`, {
    method: 'POST',
    body: { lockId },
    timeoutMs: 3_000,
    ...options,
  })
}

/**
 * @param {{
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{ available: boolean, pets?: string[], raw?: object, error?: string }>}
 */
export async function probeDshPet(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { available: false, error: 'no-fetch' }
  }

  const base = String((options.baseUrl ?? defaultBaseUrl) || '').replace(/\/$/, '')
  const url = `${base}${DSH_PET_PREFIX}/state`
  const timeoutMs = options.timeoutMs ?? 1_500
  const ac = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => { try { ac?.abort() } catch { /* ignore */ } }, timeoutMs)

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: ac?.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return { available: false, error: `http-${res.status}` }
    const raw = await res.json()
    const pets = raw?.pets && typeof raw.pets === 'object' ? Object.keys(raw.pets) : []
    return { available: true, pets, raw }
  } catch (e) {
    return { available: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 同源相对路径（浏览器）或绝对 origin（Host）调用。
 */
export async function callDshPet(path, { method = 'GET', body, fetchImpl, timeoutMs = 3_000, baseUrl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'no-fetch' }
  }
  const base = String((baseUrl ?? defaultBaseUrl) || '').replace(/\/$/, '')
  const url = `${base}${DSH_PET_PREFIX}${path}`
  const ac = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => { try { ac?.abort() } catch { /* ignore */ } }, timeoutMs)
  try {
    const res = await fetchFn(url, {
      method,
      signal: ac?.signal,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data = null
    try { data = await res.json() } catch { data = null }
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}

export { withSurface }
