/**
 * glance 图内坐标 ↔ 屏幕物理像素。
 * 模型看的是缩略图；act 必须用物理像素。换算不过会差一大截。
 *
 * @module src/coords.js
 */

/**
 * @typedef {{
 *   originX: number,
 *   originY: number,
 *   captureW: number,
 *   captureH: number,
 *   imageW: number,
 *   imageH: number,
 *   quality?: string,
 *   windowTitle?: string | null,
 *   at?: number,
 * }} GlanceMap
 */

/**
 * @param {number} imageX
 * @param {number} imageY
 * @param {GlanceMap} map
 * @returns {{ x: number, y: number, mapped: boolean }}
 */
export function mapImageToScreen(imageX, imageY, map) {
  const ix = Number(imageX)
  const iy = Number(imageY)
  const imgW = Number(map?.imageW) || 0
  const imgH = Number(map?.imageH) || 0
  const capW = Number(map?.captureW) || 0
  const capH = Number(map?.captureH) || 0
  const ox = Number(map?.originX) || 0
  const oy = Number(map?.originY) || 0
  if (![ix, iy, imgW, imgH, capW, capH].every(Number.isFinite) || imgW <= 0 || imgH <= 0) {
    return { x: ix, y: iy, mapped: false }
  }
  const x = Math.round(ox + (ix / imgW) * capW)
  const y = Math.round(oy + (iy / imgH) * capH)
  return { x, y, mapped: true }
}

/**
 * 从 glance shot 建换算表。
 * @param {object} shot
 * @param {{ region?: string | {x:number,y:number,w:number,h:number} | null }} [opts]
 * @returns {GlanceMap | null}
 */
export function buildGlanceMap(shot, opts = {}) {
  if (!shot) return null
  const imageW = Number(shot.width) || 0
  const imageH = Number(shot.height) || 0
  if (imageW <= 0 || imageH <= 0) return null

  let originX = 0
  let originY = 0
  let captureW = 0
  let captureH = 0

  const rect = shot.rect || shot.captureRect || null
  if (rect && typeof rect === 'object') {
    if (Array.isArray(rect) && rect.length >= 4) {
      originX = Number(rect[0]) || 0
      originY = Number(rect[1]) || 0
      captureW = Math.max(1, (Number(rect[2]) || 0) - originX)
      captureH = Math.max(1, (Number(rect[3]) || 0) - originY)
    } else if (rect.w != null && rect.h != null) {
      originX = Number(rect.x) || 0
      originY = Number(rect.y) || 0
      captureW = Math.max(1, Number(rect.w) || 0)
      captureH = Math.max(1, Number(rect.h) || 0)
    }
  }

  const winRect = shot.window?.rect
  if ((!captureW || !captureH) && Array.isArray(winRect) && winRect.length >= 4) {
    originX = Number(winRect[0]) || 0
    originY = Number(winRect[1]) || 0
    captureW = Math.max(1, (Number(winRect[2]) || 0) - originX)
    captureH = Math.max(1, (Number(winRect[3]) || 0) - originY)
  }

  const region = opts.region
  if ((!captureW || !captureH) && region) {
    let r = region
    if (typeof region === 'string') {
      const parts = region.split(/[,\s]+/).map(Number)
      if (parts.length >= 4 && parts.every(Number.isFinite)) {
        r = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
      }
    }
    if (r && typeof r === 'object' && r.w != null) {
      originX = Number(r.x) || 0
      originY = Number(r.y) || 0
      captureW = Math.max(1, Number(r.w) || 0)
      captureH = Math.max(1, Number(r.h) || 0)
    }
  }

  if (!captureW || !captureH) {
    const screen = shot.screen || {}
    const virt = screen.virtual
    if (virt?.w && virt?.h) {
      originX = Number(virt.x) || 0
      originY = Number(virt.y) || 0
      captureW = Number(virt.w)
      captureH = Number(virt.h)
    } else {
      captureW = Number(screen.w || screen.width) || 0
      captureH = Number(screen.h || screen.height) || 0
      originX = Number(screen.x) || 0
      originY = Number(screen.y) || 0
    }
  }

  if (!captureW || !captureH) return null

  return {
    originX,
    originY,
    captureW,
    captureH,
    imageW,
    imageH,
    quality: shot.quality ? String(shot.quality) : undefined,
    windowTitle: shot.window?.title ? String(shot.window.title) : null,
    at: Date.now(),
  }
}

/**
 * 人话换算提示（进 glance 信封）。
 * @param {GlanceMap} map
 */
export function formatCoordHint(map) {
  if (!map) return ''
  const scale = (map.captureW / map.imageW).toFixed(2)
  return (
    `坐标换算：图内 (ix,iy) → 屏幕物理像素 `
    + `x=${map.originX}+ix×${map.captureW}/${map.imageW}，`
    + `y=${map.originY}+iy×${map.captureH}/${map.imageH}`
    + `（约×${scale}）。act 请用物理像素，或传 imageX/imageY 让宿主换算。`
  )
}

/**
 * 若模型把缩略图坐标当成了屏幕坐标，自动救回来。
 * 条件：落在图内、且图相对抓取区明显缩小。
 *
 * @param {number} x
 * @param {number} y
 * @param {GlanceMap | null | undefined} map
 * @returns {{ x: number, y: number, remapped: boolean }}
 */
export function maybeRemapImageCoordsAsScreen(x, y, map) {
  const xx = Number(x)
  const yy = Number(y)
  if (!map || ![xx, yy].every(Number.isFinite)) {
    return { x: xx, y: yy, remapped: false }
  }
  const downscaled = map.imageW < map.captureW * 0.92 || map.imageH < map.captureH * 0.92
  if (!downscaled) return { x: xx, y: yy, remapped: false }
  if (xx < 0 || yy < 0 || xx >= map.imageW || yy >= map.imageH) {
    return { x: xx, y: yy, remapped: false }
  }
  // 已经像物理坐标（明显大于图宽）则不动
  if (xx >= map.imageW || yy >= map.imageH) {
    return { x: xx, y: yy, remapped: false }
  }
  const mapped = mapImageToScreen(xx, yy, map)
  if (!mapped.mapped) return { x: xx, y: yy, remapped: false }
  // 换算后变化太小说明本来就对
  if (Math.abs(mapped.x - xx) < 2 && Math.abs(mapped.y - yy) < 2) {
    return { x: xx, y: yy, remapped: false }
  }
  return { x: mapped.x, y: mapped.y, remapped: true }
}
