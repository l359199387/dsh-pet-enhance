/**
 * `glance` 工具本体：抓一帧 → 存成附件 → 把图交给模型。
 *
 * 图只能作为**本次工具结果**返回（硬约束 3）。这里不做任何「后台推图」，
 * 也不写会话事件：模型只有在调工具的那一步才看到屏幕，这也限制了图钱。
 *
 * `attachments.saveImage` 必须 `.call(svc, …)`：它内部用 `this` 拿存储，
 * 直接 `svc.saveImage({...})` 会丢 this（硬约束 2，参考项目踩过）。
 *
 * @module src/tool-glance.js
 */

import { captureScreen, normalizeQuality } from './capture.js'
import { glanceToolSpec } from './tool-spec.js'

function failureText(error) {
  const code = error?.code
  if (code === 'ABORTED') return '这次抓屏被取消了，没有图。'
  if (code === 'TIMEOUT') return '抓屏超时了（20 秒）。屏幕可能被独占或系统卡住，稍后再试。'
  if (code === 'SPAWN_FAILED') return `起不来 PowerShell：${error?.message ?? error}`
  return `抓屏失败：${error?.message ?? error}`
}

function envelope(shot) {
  const monitors = shot.monitors.length
  const screen = shot.screen ?? {}
  const screenSize = screen.w && screen.h ? `${screen.w}×${screen.h}` : '未知尺寸'
  return `整屏 ${screenSize}（${monitors || 1} 个显示器）→ ${shot.width}×${shot.height} · ${shot.quality} 档 · ${shot.ms}ms`
}

/**
 * 直接返回 `ctx.tools.register()` 收的**普通对象**：`defineTool()` 属于宿主内部包，
 * Host-only bundle 里 import 不到它（`Cannot find package '@deepseek-ai/dsh-tools'`）。
 * 本机的 billion-context 插件同样是裸注册纯对象，这是宿主支持的形状。
 *
 * @param {{
 *   home: string,
 *   attachments?: { saveImage?: Function },
 *   log?: (message: string) => void,
 * }} options
 */
export function createGlanceTool({ home, attachments, log } = {}) {
  return {
    ...glanceToolSpec(),
    async execute(args, exec) {
      const action = String(args?.action ?? 'see').trim().toLowerCase() || 'see'
      const quality = normalizeQuality(args?.quality)

      if (action !== 'see') {
        return {
          text: `A1 只会 action:"see"（收到 "${action}"）。窗口、区域、连看几帧是 A2 的事，现在请用 see 看整屏。`,
          images: [],
          meta: { ok: false, unsupported: true, action, quality },
        }
      }

      let shot
      try {
        shot = await captureScreen({ quality, home, signal: exec?.signal })
      } catch (error) {
        log?.(`glance 抓屏失败：${error?.code ?? ''} ${error?.message ?? error}`)
        return {
          text: failureText(error),
          images: [],
          meta: { ok: false, error: { code: error?.code ?? 'CAPTURE_FAILED', message: String(error?.message ?? error) }, quality },
        }
      }

      const text = envelope(shot)
      const meta = {
        ok: true,
        quality: shot.quality,
        width: shot.width,
        height: shot.height,
        bytes: shot.png.byteLength,
        screen: shot.screen,
        monitors: shot.monitors,
        ms: shot.ms,
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
