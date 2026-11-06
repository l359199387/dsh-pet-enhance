/**
 * 小蓝鲸本地设置（`~/.dsh/pet-enhance/settings.json`）。
 *
 * @module src/settings.js
 */

import { readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DEFAULT_SETTINGS = Object.freeze({
  /** 右键「实时看屏幕」：开则周期盯屏并冒泡变化。 */
  liveWatch: false,
  /** C1：允许 `act` 真动手。也可用环境变量 DSH_PET_ENHANCE_ACT=1。 */
  actEnabled: false,
})

export function settingsPath(home) {
  return join(home, 'settings.json')
}

/** 同步判断 act 是否开启（工具热路径；环境变量优先）。 */
export function isActEnabled(home) {
  const env = String(process.env.DSH_PET_ENHANCE_ACT || process.env.DSH_GLANCE_ACT || '')
    .trim()
    .toLowerCase()
  if (env === '1' || env === 'true' || env === 'yes') return true
  if (env === '0' || env === 'false' || env === 'no') return false
  try {
    // 同步读：避免每次 act 都 async；文件很小。
    const raw = readFileSync(settingsPath(home), 'utf8')
    const data = JSON.parse(raw)
    return Boolean(data?.actEnabled)
  } catch {
    return DEFAULT_SETTINGS.actEnabled
  }
}

/** 同步判断「实时看屏幕」是否开启（教学入口用）。 */
export function isLiveWatchEnabled(home) {
  const env = String(process.env.DSH_PET_ENHANCE_LIVE || process.env.DSH_GLANCE_LIVE || '')
    .trim()
    .toLowerCase()
  if (env === '1' || env === 'true' || env === 'yes') return true
  if (env === '0' || env === 'false' || env === 'no') return false
  try {
    const raw = readFileSync(settingsPath(home), 'utf8')
    const data = JSON.parse(raw)
    return Boolean(data?.liveWatch)
  } catch {
    return DEFAULT_SETTINGS.liveWatch
  }
}

/**
 * @param {string} home
 * @returns {Promise<{ liveWatch: boolean, actEnabled: boolean }>}
 */
export async function loadSettings(home) {
  try {
    const raw = await readFile(settingsPath(home), 'utf8')
    const data = JSON.parse(raw)
    return {
      liveWatch: Boolean(data?.liveWatch),
      actEnabled: Boolean(data?.actEnabled),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * @param {string} home
 * @param {{ liveWatch?: boolean, actEnabled?: boolean }} patch
 */
export async function saveSettings(home, patch) {
  const cur = await loadSettings(home)
  const next = {
    liveWatch: patch.liveWatch !== undefined ? Boolean(patch.liveWatch) : cur.liveWatch,
    actEnabled: patch.actEnabled !== undefined ? Boolean(patch.actEnabled) : cur.actEnabled,
  }
  await mkdir(dirname(settingsPath(home)), { recursive: true })
  await writeFile(settingsPath(home), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
