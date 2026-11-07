/**
 * `glance` 工具本体：抓一帧 / watch 多帧 → 存成附件 → 把图交给模型。
 *
 * 图只能作为**本次工具结果**返回（硬约束 3）。这里不做任何「后台推图」，
 * 也不写会话事件：模型只有在调工具的那一步才看到屏幕，这也限制了图钱。
 *
 * `attachments.saveImage` 必须 `.call(svc, …)`：它内部用 `this` 拿存储，
 * 直接 `svc.saveImage({...})` 会丢 this（硬约束 2，参考项目踩过）。
 *
 * @module src/tool-glance.js
 */

import { captureFrame, normalizeQuality, parseRegion } from './capture.js'
import { glanceToolSpec } from './tool-spec.js'
import { runWatch, createWakeBudget, WATCH_DEFAULTS } from './watch-loop.js'

function failureText(error) {
  const code = error?.code
  if (code === 'ABORTED') return '这次抓屏被取消了，没有图。'
  if (code === 'TIMEOUT') return '抓屏超时了。屏幕可能被独占或 sidecar 卡住，稍后再试。'
  if (code === 'SPAWN_FAILED') return `起不来抓屏进程：${error?.message ?? error}`
  if (code === 'SIDECAR_DOWN' || code === 'NO_PYTHON' || code === 'NO_SCRIPT') {
    return `Python sidecar 不可用（${error?.message ?? code}）。整屏可退 PowerShell；单窗口 / watch 需要 sidecar。`
  }
  if (code === 'WINDOW_NOT_FOUND') {
    const list = Array.isArray(error?.candidates) && error.candidates.length
      ? `最接近的窗口：${error.candidates.join(' / ')}`
      : '当前没有可匹配的可见窗口。'
    return `没找到这个窗口。${list}`
  }
  if (code === 'WINDOW_AMBIGUOUS') {
    const list = Array.isArray(error?.candidates) ? error.candidates.join(' / ') : ''
    return `有多个窗口都像是这个名字，请写得更具体。候选：${list}`
  }
  if (code === 'WAKE_BUDGET') {
    return String(error?.message ?? '叫醒预算用尽，已停止 watch。')
  }
  if (code === 'BAD_REQUEST') return `参数不对：${error?.message ?? error}`
  return `抓屏失败：${error?.message ?? error}`
}

function envelope(shot) {
  const bits = []
  if (shot.window?.title) {
    bits.push(`窗口「${shot.window.title}」`)
    const rect = shot.window.rect
    if (Array.isArray(rect) && rect.length === 4) {
      bits.push(`原区域 ${rect[2] - rect[0]}×${rect[3] - rect[1]}`)
    }
  } else {
    const screen = shot.screen ?? {}
    const screenSize = screen.w && screen.h ? `${screen.w}×${screen.h}` : '未知尺寸'
    const monitors = Array.isArray(shot.monitors) ? shot.monitors.length : 0
    bits.push(`整屏 ${screenSize}${monitors ? `（${monitors} 个显示器）` : ''}`)
  }
  bits.push(`→ ${shot.width}×${shot.height}`)
  bits.push(`${shot.quality} 档`)
  bits.push(`${shot.ms}ms`)
  bits.push(shot.engine || 'unknown')
  return bits.join(' · ')
}

function watchEnvelope(result) {
  const sheets = result.mosaicCount || 1
  const bits = [
    `watch ${result.elapsedSec}s`,
    `${result.framesKept} 帧（采样 ${result.samples}）`,
    sheets > 1
      ? `${sheets} 张拼图（${result.cols}×${result.rows}）`
      : `${result.cols}×${result.rows}`,
    `→ ${result.width}×${result.height}`,
    `${result.quality} 档 · ~${result.tokens} token`,
  ]
  if (result.silent) {
    bits.push('屏幕基本没变')
  } else {
    bits.push(`最大变化分 ${Number(result.maxScore || 0).toFixed(1)}`)
  }
  return bits.join(' · ')
}

/**
 * @param {{
 *   home: string,
 *   attachments?: { saveImage?: Function },
 *   log?: (message: string) => void,
 *   sidecar?: { call: Function, isAlive?: Function, getHello?: Function } | null,
 *   onLooking?: () => void,
 *   onIdle?: () => void,
 *   wakeBudget?: ReturnType<typeof createWakeBudget>,
 * }} options
 */
export function createGlanceTool({
  home,
  attachments,
  log,
  sidecar,
  onLooking,
  onIdle,
  wakeBudget,
} = {}) {
  const wakes = wakeBudget ?? createWakeBudget(WATCH_DEFAULTS.maxAutonomousWakes)

  return {
    ...glanceToolSpec(),
    /** 供外部（聊天闸门）在用户发言时清零叫醒计数 */
    noteUserTurn() {
      wakes.noteUserTurn()
    },
    wakeStatus() {
      return wakes.status()
    },
    async execute(args, exec) {
      const action = String(args?.action ?? 'see').trim().toLowerCase() || 'see'
      const quality = normalizeQuality(args?.quality)
      const window = args?.window
      const region = args?.region

      if (action !== 'see' && action !== 'watch') {
        return {
          text: `目前只会 action:"see" | "watch"（收到 "${action}"）。`,
          images: [],
          meta: { ok: false, unsupported: true, action, quality },
        }
      }

      if (action === 'watch') {
        const gate = wakes.beginWatch()
        if (!gate.ok) {
          return {
            text: gate.reason || failureText({ code: 'WAKE_BUDGET' }),
            images: [],
            meta: {
              ok: false,
              error: { code: 'WAKE_BUDGET', message: gate.reason },
              action: 'watch',
              wakes: gate.wakes,
              maxWakes: gate.max,
            },
          }
        }

        try { onLooking?.() } catch { /* ignore */ }

        let result
        try {
          let parsedRegion = null
          try {
            parsedRegion = parseRegion(region)
          } catch (e) {
            try { onIdle?.() } catch { /* ignore */ }
            return {
              text: failureText(e),
              images: [],
              meta: { ok: false, error: { code: e.code || 'BAD_REQUEST', message: String(e.message) } },
            }
          }

          result = await runWatch({
            home,
            sidecar: sidecar || undefined,
            quality,
            window,
            region: parsedRegion,
            seconds: args?.seconds,
            // 兼容旧参数名 frames → 每张上限（see-now maxFrames/cap）
            maxFramesPerSheet: args?.maxFramesPerSheet ?? args?.frames,
            preferFrames: args?.preferFrames,
            maxWaitSec: args?.maxWaitSec,
            signal: exec?.signal,
            log,
          })
        } catch (error) {
          log?.(`glance watch 失败：${error?.code ?? ''} ${error?.message ?? error}`)
          try { onIdle?.() } catch { /* ignore */ }
          return {
            text: failureText(error),
            images: [],
            meta: {
              ok: false,
              error: {
                code: error?.code ?? 'CAPTURE_FAILED',
                message: String(error?.message ?? error),
                candidates: error?.candidates,
              },
              action: 'watch',
              quality,
              wakes: gate.wakes,
            },
          }
        }
        try { onIdle?.() } catch { /* ignore */ }

        let text = watchEnvelope(result)
        if (result.silent) {
          text += '\n说明：这段时间屏幕基本没变；图里是兜底帧，不是密集操作回放。'
        }
        text += `\n叫醒 ${gate.wakes}/${gate.max}（用户说话会清零；连续无人回应满额会停）。`

        const meta = {
          ok: true,
          action: 'watch',
          quality: result.quality,
          width: result.width,
          height: result.height,
          bytes: result.png.byteLength,
          tokens: result.tokens,
          expectedTokens: result.expectedTokens,
          framesKept: result.framesKept,
          samples: result.samples,
          silent: result.silent,
          elapsedSec: result.elapsedSec,
          wakes: gate.wakes,
          maxWakes: gate.max,
        }

        const saveImage = attachments?.saveImage
        if (typeof saveImage !== 'function') {
          return {
            text: `${text}\n（attachments 服务不可用，这一帧没能交给你。）`,
            images: [],
            meta,
          }
        }

        const pngs = Array.isArray(result.pngs) && result.pngs.length
          ? result.pngs
          : (result.png ? [result.png] : [])
        /** @type {object[]} */
        const images = []
        try {
          for (let i = 0; i < pngs.length; i += 1) {
            const buf = pngs[i]
            if (!buf?.byteLength) continue
            const ref = await saveImage.call(attachments, {
              data: buf,
              mediaType: 'image/png',
              name: pngs.length > 1
                ? `glance-watch-${result.quality}-${i + 1}of${pngs.length}.png`
                : `glance-watch-${result.quality}-${result.width}x${result.height}.png`,
            })
            images.push(ref)
          }
        } catch (error) {
          log?.(`glance watch 存图失败：${error?.message ?? error}`)
          return {
            text: `${text}\n（图抓到了，但存附件失败：${error?.message ?? error}）`,
            images: [],
            meta,
          }
        }

        if (!images.length) {
          return {
            text: `${text}\n（attachments 存图后为空。）`,
            images: [],
            meta,
          }
        }

        meta.mosaicCount = result.mosaicCount || images.length
        meta.bytes = pngs.reduce((n, b) => n + (b?.byteLength || 0), 0)
        return { text, images, meta }
      }

      // —— see ——
      try { onLooking?.() } catch { /* 状态旁路不能影响工具 */ }

      let shot
      try {
        shot = await captureFrame({
          sidecar: sidecar || undefined,
          quality,
          window,
          region,
          home,
          signal: exec?.signal,
        })
      } catch (error) {
        log?.(`glance 抓屏失败：${error?.code ?? ''} ${error?.message ?? error}`)
        try { onIdle?.() } catch { /* ignore */ }
        return {
          text: failureText(error),
          images: [],
          meta: {
            ok: false,
            error: {
              code: error?.code ?? 'CAPTURE_FAILED',
              message: String(error?.message ?? error),
              candidates: error?.candidates,
            },
            quality,
          },
        }
      }
      try { onIdle?.() } catch { /* ignore */ }

      const text = envelope(shot)
      const meta = {
        ok: true,
        action: 'see',
        quality: shot.quality,
        width: shot.width,
        height: shot.height,
        bytes: shot.png.byteLength,
        screen: shot.screen,
        monitors: shot.monitors,
        ms: shot.ms,
        engine: shot.engine,
        window: shot.window,
        active: shot.active,
        cursor: shot.cursor,
      }

      const saveImage = attachments?.saveImage
      if (typeof saveImage !== 'function') {
        return {
          text: `${text}\n（attachments 服务不可用，这一帧没能交给你；检查宿主是否挂了 attachments。）`,
          images: [],
          meta,
        }
      }

      let ref
      try {
        ref = await saveImage.call(attachments, {
          data: shot.png,
          mediaType: 'image/png',
          name: `glance-${shot.quality}-${shot.width}x${shot.height}.png`,
        })
      } catch (error) {
        log?.(`glance 存图失败：${error?.message ?? error}`)
        return {
          text: `${text}\n（图抓到了，但存附件失败：${error?.message ?? error}）`,
          images: [],
          meta,
        }
      }

      return { text, images: [ref], meta }
    },
  }
}
