/**
 * 把 Host 的 HTTP origin 写到数据目录，供 dsh-pet chat-gate 补丁回连（不依赖易变的环境变量）。
 *
 * @module src/host-origin.js
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function hostOriginPath(home) {
  return join(home, 'host-origin.txt')
}

/**
 * @param {string} home
 * @param {string} origin
 */
export function writeHostOrigin(home, origin) {
  const o = String(origin || '').trim().replace(/\/$/, '')
  if (!o) return
  mkdirSync(home, { recursive: true })
  writeFileSync(hostOriginPath(home), `${o}\n`, 'utf8')
}

/**
 * @param {string} home
 * @returns {string}
 */
export function readHostOrigin(home) {
  const file = hostOriginPath(home)
  if (!existsSync(file)) return ''
  try {
    return String(readFileSync(file, 'utf8')).trim().replace(/\/$/, '')
  } catch {
    return ''
  }
}
