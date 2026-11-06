/**
 * 小蓝鲸本地设置（`~/.dsh/pet-enhance/settings.json`）。
 *
 * @module src/settings.js
 */

import { readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_LOCALE, normalizeLocale } from './i18n.js'

export const DEFAULT_SETTINGS = Object.freeze({
  /** 右键「实时看屏幕」：开则周期盯屏并冒泡变化。 */
  liveWatch: false,
  /** C1：允许 `act` 真动手。也可用环境变量 DSH_PET_ENHANCE_ACT=1。 */
  actEnabled: false,
  /** UI / 菜单语言：zh | en，默认中文。 */
  locale: DEFAULT_LOCALE,
})

export function settingsPath(home) {
  return join(home, 'settings.json')
}

function readSync(home) {
  try {
    const raw = readFileSync(settingsPath(home), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 同步判断 act 是否开启（工具热路径；环境变量优先）。 */
export function isActEnabled(home) {
  const env = String(process.env.DSH_PET_ENHANCE_ACT || process.env.DSH_GLANCE_ACT || '')
    .trim()
    .toLowerCase()
  if (env === '1' || env === 'true' || env === 'yes') return true
  if (env === '0' || env === 'false' || env === 'no') return false
  const data = readSync(home)
  return data ? Boolean(data.actEnabled) : DEFAULT_SETTINGS.actEnabled
}

/** 同步判断「实时看屏幕」是否开启（教学入口用）。 */
export function isLiveWatchEnabled(home) {
  const env = String(process.env.DSH_PET_ENHANCE_LIVE || process.env.DSH_GLANCE_LIVE || '')
    .trim()
    .toLowerCase()
  if (env === '1' || env === 'true' || env === 'yes') return true
  if (env === '0' || env === 'false' || env === 'no') return false
  const data = readSync(home)
  return data ? Boolean(data.liveWatch) : DEFAULT_SETTINGS.liveWatch
}

/** 同步读语言（菜单文案热路径）。 */
export function getLocale(home) {
  const env = String(process.env.DSH_PET_ENHANCE_LOCALE || process.env.DSH_GLANCE_LOCALE || '').trim()
  if (env) return normalizeLocale(env)
  const data = readSync(home)
  return normalizeLocale(data?.locale || DEFAULT_SETTINGS.locale)
}

/**
 * @param {string} home
 * @returns {Promise<{ liveWatch: boolean, actEnabled: boolean, locale: string }>}
 */
export async function loadSettings(home) {
  try {
    const raw = await readFile(settingsPath(home), 'utf8')
    const data = JSON.parse(raw)
    return {
      liveWatch: Boolean(data?.liveWatch),
      actEnabled: Boolean(data?.actEnabled),
      locale: normalizeLocale(data?.locale || DEFAULT_SETTINGS.locale),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * @param {string} home
 * @param {{ liveWatch?: boolean, actEnabled?: boolean, locale?: string }} patch
 */
export async function saveSettings(home, patch) {
  const cur = await loadSettings(home)
  const next = {
    liveWatch: patch.liveWatch !== undefined ? Boolean(patch.liveWatch) : cur.liveWatch,
    actEnabled: patch.actEnabled !== undefined ? Boolean(patch.actEnabled) : cur.actEnabled,
    locale: patch.locale !== undefined ? normalizeLocale(patch.locale) : cur.locale,
  }
  await mkdir(dirname(settingsPath(home)), { recursive: true })
  await writeFile(settingsPath(home), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
