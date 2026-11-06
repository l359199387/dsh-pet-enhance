/**
 * 「实时看屏幕」：开着时周期抓一帧，窗口标题变了就冒泡一句。
 * 不每拍都附图对话（费 token）；用户要细看仍说「看一眼桌面」。
 *
 * @module src/live-watch.js
 */

import { broadcastToDshPet, callDshPet } from './dsh-pet.js'
import { captureFrame } from './capture.js'
import { appendEpisode, buildGlanceEpisode } from './episode.js'

export const LIVE_WATCH_INTERVAL_MS = 15_000

/**
 * @param {{
 *   home: string,
 *   sidecar?: object | (() => object | null | undefined),
 *   petId?: string,
 *   intervalMs?: number,
 *   log?: (m: string) => void,
 *   capture?: typeof captureFrame,
 *   onLooking?: () => void,
 *   onIdle?: () => void,
 * }} options
 */
export function createLiveWatch(options) {
  const pet = options.petId || 'main'
  const log = options.log ?? (() => {})
  const intervalMs = options.intervalMs ?? LIVE_WATCH_INTERVAL_MS
  const capture = options.capture ?? captureFrame
  let timer = null
  let busy = false
  let lastKey = ''

  function fingerprint(shot) {
    const title = shot?.window?.title ? String(shot.window.title) : ''
    const screen = shot?.screen?.w && shot?.screen?.h
      ? `${shot.screen.w}x${shot.screen.h}`
      : ''
    const size = shot?.png?.byteLength || 0
    return `${title}|${screen}|${shot?.width}x${shot?.height}|${size}`
  }

  async function tick() {
    if (busy) return
    busy = true
    const t0 = Date.now()
    try {
      try { options.onLooking?.() } catch { /* ignore */ }
      await callDshPet('/work-status', {
        method: 'POST',
        body: { state: 'working', task: 'live-watch' },
      }).catch(() => {})

      const sidecar = typeof options.sidecar === 'function'
        ? options.sidecar()
        : options.sidecar
      const shot = await capture({
        sidecar,
        quality: 'low',
        home: options.home,
        timeoutMs: 20_000,
      })
      const key = fingerprint(shot)
      if (!lastKey) {
        lastKey = key
        log('live-watch：已建立基线')
        return
      }
      if (key === lastKey) return
      lastKey = key
      const where = shot.window?.title
        ? `窗口「${String(shot.window.title).slice(0, 40)}」`
        : '整屏'
      const text = `屏幕有变化：${where}（${shot.width}×${shot.height}）`
      await broadcastToDshPet(text, { pet, duration: 8_000 })
      await appendEpisode(options.home, buildGlanceEpisode({
        userText: '实时看屏幕',
        shot,
        result: 'ok',
        durMs: Date.now() - t0,
        reply: text,
      }))
      log(`live-watch：${text}`)
    } catch (e) {
      log(`live-watch 抓屏失败：${e?.message ?? e}`)
    } finally {
      await callDshPet('/work-status', { method: 'DELETE' }).catch(() => {})
      try { options.onIdle?.() } catch { /* ignore */ }
      busy = false
    }
  }

  function start() {
    if (timer) return
    lastKey = ''
    timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
    tick().catch(() => {})
    log('live-watch：已开启')
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    lastKey = ''
    log('live-watch：已关闭')
  }

  function isRunning() {
    return Boolean(timer)
  }

  return { start, stop, tick, isRunning }
}
