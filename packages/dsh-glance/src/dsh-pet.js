/**
 * 与已安装的 `dsh-pet` 互操作（不拷贝其素材）。
 *
 * dsh-pet 动画/形象是 CC BY-NC-SA 4.0，禁止商用、禁止塞进本仓库。
 * 合法做法：用户自己装 dsh-pet，我们调 `/dsh-pet-7340/*` 让它开口/切状态。
 *
 * @module src/dsh-pet.js
 */

export const DSH_PET_PREFIX = '/dsh-pet-7340'

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

  const base = String(options.baseUrl || '').replace(/\/$/, '')
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
 * 同源相对路径调用（浏览器 / 与 DSH 同端口的 Host 侧都可以用）。
 */
export async function callDshPet(path, { method = 'GET', body, fetchImpl, timeoutMs = 3_000 } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'no-fetch' }
  }
  const ac = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => { try { ac?.abort() } catch { /* ignore */ } }, timeoutMs)
  try {
    const res = await fetchFn(`${DSH_PET_PREFIX}${path}`, {
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
