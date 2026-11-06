/**
 * `/api/glance/*` 的信任栅栏。
 *
 * ## 为什么必须有
 *
 * webServer 按「最长前缀」分发，而 `/api/glance` 比内核自己的 `/api` 长——
 * 也就是说这些请求**根本不会经过内核的准入检查**。不设防的话，本机任何进程
 * 都能打 `/api/glance/confirm`，把「用户已确认」这件事伪造出来（07 §13）。
 *
 * ## 两层
 *
 * 1. 组合里有 `connection` 服务时，直接问它——那是内核给自身 `/api` 用的同一套
 *    判定（信任栅栏 + 浏览器认证 cookie），插件不会比应用更松。
 * 2. 没有该服务时用结构等价的一组规则：Host 必须 loopback（防 DNS rebinding）、
 *    不许跨站 fetch、带了 Origin / Referer 就必须与 Host 同源。
 *
 * 服务自己报错时一律 503，绝不因为「判定不出来」就放行——那等于把认证关掉。
 *
 * @module src/trust.js
 */

const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** 把 Host / Origin / Referer 拆成 `{scheme, hostname, port}`，端口按协议补默认值。 */
function authority(value, fallbackScheme = 'http') {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${fallbackScheme}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/** 桌面版把页面从 `dsh-app://app` 转发到 loopback 时会留下这个 Referer。 */
function isDesktopRelay(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function structuralReason(req) {
  const headers = req?.headers ?? {}
  const host = authority(headers.host)
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 'cross-site'

  for (const header of ['origin', 'referer']) {
    const raw = headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (header === 'referer' && isDesktopRelay(raw)) {
      // 桌面转发会剥掉两枚浏览器标记却留下这个 Referer：它不是一次 Origin 授权，
      // 也不该覆盖已经挂载的 Host 认证判定。
      if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers'
      continue
    }
    const origin = authority(raw.trim())
    if (origin === null) return `${header}-invalid`
    if (origin.scheme !== host.scheme || origin.hostname !== host.hostname || origin.port !== host.port) {
      return `${header}-mismatch`
    }
  }
  return undefined
}

/**
 * 判定请求该不该放行。
 *
 * @param req `node:http` 的 IncomingMessage
 * @param connection 组合里的 `connection` 服务（可选，可能比插件晚挂载）
 * @returns `undefined` 表示放行，否则是该回的状态码
 */
export function rejectionFor(req, connection) {
  // 两种拼法都要认：新版 `admit` 返回 `{rejection}`，旧版 `requestRejection` 直接返回状态码。
  // 认错一次就会把每个请求都判成失败。
  const admit = connection?.admit
  if (typeof admit === 'function') {
    try {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return structuralReason(req) === undefined ? undefined : 403
      return status
    } catch {
      return 503
    }
  }

  const reject = connection?.requestRejection
  if (typeof reject === 'function') {
    try {
      const status = reject.call(connection, req)
      if (status === undefined) return structuralReason(req) === undefined ? undefined : 403
      return status
    } catch {
      return 503
    }
  }

  return structuralReason(req) === undefined ? undefined : 403
}
