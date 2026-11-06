/**
 * 小蓝鲸本地设置（`~/.dsh/glance/settings.json`）。
 *
 * @module src/settings.js
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DEFAULT_SETTINGS = Object.freeze({
  /** 右键「实时看屏幕」：开则周期盯屏并冒泡变化。 */
  liveWatch: false,
})

export function settingsPath(home) {
  return join(home, 'settings.json')
}

/**
 * @param {string} home
 * @returns {Promise<{ liveWatch: boolean }>}
 */
export async function loadSettings(home) {
  try {
    const raw = await readFile(settingsPath(home), 'utf8')
    const data = JSON.parse(raw)
    return {
      liveWatch: Boolean(data?.liveWatch),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * @param {string} home
 * @param {{ liveWatch?: boolean }} patch
 */
export async function saveSettings(home, patch) {
  const cur = await loadSettings(home)
  const next = {
    liveWatch: patch.liveWatch !== undefined ? Boolean(patch.liveWatch) : cur.liveWatch,
  }
  await mkdir(dirname(settingsPath(home)), { recursive: true })
  await writeFile(settingsPath(home), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
