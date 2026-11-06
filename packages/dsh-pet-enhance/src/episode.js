/**
 * 看屏情景：append-only JSONL，按月分片。
 *
 * 不写截图字节、不写剪贴板、不写文件内容。
 * 黑名单窗口标题命中时整条不写（不是先记再涂黑）。
 *
 * @module src/episode.js
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 与 docs/07 精神一致的轻量标题黑名单（B2 只挡明显敏感窗）。 */
export const EPISODE_TITLE_BLOCK_RE =
  /密码|口令|credential|password|passwd|1password|bitwarden|keepass|银行|wallet|验证码|authenti/i

export function shouldSkipEpisode(windowTitle) {
  const t = String(windowTitle ?? '')
  return t !== '' && EPISODE_TITLE_BLOCK_RE.test(t)
}

export function episodeMonthKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export function episodeFilePath(home, date = new Date()) {
  return join(home, 'episodes', `${episodeMonthKey(date)}.jsonl`)
}

/**
 * 组一条看屏 episode（纯数据，不落盘）。
 * @param {{
 *   userText: string,
 *   shot?: { width?: number, height?: number, quality?: string, engine?: string, ms?: number, window?: { title?: string } | null, screen?: { w?: number, h?: number } },
 *   result: string,
 *   durMs: number,
 *   reply?: string,
 *   error?: string,
 * }} input
 */
export function buildGlanceEpisode(input) {
  const shot = input.shot
  const win = shot?.window?.title ? String(shot.window.title) : ''
  const src = win ? `win:${win.slice(0, 40)}` : 'src:screen'
  const title = String(input.userText || '看一眼').trim().slice(0, 80) || '看一眼'
  return {
    at: new Date().toISOString(),
    kind: 'glance',
    title,
    signature: `verb:see|${src}|q:${shot?.quality || 'low'}`,
    goal: title,
    apps: win ? [win.slice(0, 80)] : [],
    steps: [
      'captureFrame(quality=low)',
      input.result === 'ok' ? 'chatWithDshPet(attachment)' : `outcome:${input.result}`,
    ],
    result: input.result,
    turns: 1,
    tools: 1,
    durMs: Math.max(0, Number(input.durMs) || 0),
    corrected: false,
    skill: null,
    meta: {
      width: shot?.width ?? null,
      height: shot?.height ?? null,
      quality: shot?.quality ?? null,
      engine: shot?.engine ?? null,
      captureMs: shot?.ms ?? null,
      screen: shot?.screen?.w && shot?.screen?.h
        ? `${shot.screen.w}x${shot.screen.h}`
        : null,
      replyChars: input.reply ? String(input.reply).length : 0,
      error: input.error ? String(input.error).slice(0, 200) : undefined,
    },
  }
}

/**
 * @param {string} home
 * @param {object} episode
 * @returns {Promise<{ ok: boolean, path?: string, skipped?: boolean, error?: string }>}
 */
export async function appendEpisode(home, episode) {
  if (!home || !episode || typeof episode !== 'object') {
    return { ok: false, error: 'bad-args' }
  }
  const win = Array.isArray(episode.apps) && episode.apps[0] ? episode.apps[0] : ''
  if (shouldSkipEpisode(win)) {
    return { ok: true, skipped: true }
  }
  const path = episodeFilePath(home)
  try {
    await mkdir(join(home, 'episodes'), { recursive: true })
    await appendFile(path, `${JSON.stringify(episode)}\n`, 'utf8')
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
