/**
 * 安全取 Cordis 可选服务（未 inject 时 Proxy 会抛，?. 挡不住）。
 *
 * @module src/host-ctx.js
 */

export function serviceOf(ctx, name) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet) return viaGet
    }
  } catch { /* 未注册 */ }
  try {
    return ctx[name] ?? null
  } catch {
    return null
  }
}
