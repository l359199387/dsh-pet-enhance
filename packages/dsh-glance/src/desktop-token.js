/**
 * 桌面 Helper 调 `/api/glance/*` 用的本机令牌（写入 ~/.dsh/glance/desktop.token）。
 * 渲染进程无 cookie，靠 `x-glance-token` 过信任栅栏。
 *
 * @module src/desktop-token.js
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function desktopTokenPath(home) {
  return join(home, 'desktop.token')
}

export function readDesktopToken(home) {
  const file = desktopTokenPath(home)
  if (!existsSync(file)) return ''
  try {
    return String(readFileSync(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

/** 没有就生成并落盘；已有则原样返回。 */
export function ensureDesktopToken(home) {
  mkdirSync(home, { recursive: true })
  const existing = readDesktopToken(home)
  if (existing && existing.length >= 16) return existing
  const token = randomBytes(24).toString('hex')
  writeFileSync(desktopTokenPath(home), `${token}\n`, 'utf8')
  return token
}

export function tokenMatches(home, headerValue) {
  const want = readDesktopToken(home)
  const got = String(headerValue ?? '').trim()
  return Boolean(want) && want.length >= 16 && got === want
}
