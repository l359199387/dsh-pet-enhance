/**
 * 从 dsh-pet memory.json 生成「最近聊天」HTML，用系统浏览器打开。
 * 桌面双击对话只是输入框，没有历史列表——靠这个补上。
 *
 * 图片/头像一律 data URI 内嵌：避免 file:// 下 SVG 裂图，也避开浏览器锁住缓存 png 导致 copy EPERM。
 *
 * @module src/recent-chat.js
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latestGlancePngPath, latestWatchPngPath } from './chat-bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_RECENT_ROUNDS = 12

export function dshPetMemoryPath() {
  return join(homedir(), '.dsh', 'dsh-pet', 'memory.json')
}

export function recentChatHtmlPath(home) {
  return join(home, 'cache', 'recent-chat.html')
}

export function recentChatAssetsDir(home) {
  return join(home, 'cache', 'recent-chat-assets')
}

/** attachmentId `sha256:abcd...` → 对象文件路径 */
export function attachmentObjectPath(attachmentId) {
  const id = String(attachmentId || '').replace(/^sha256:/i, '').trim()
  if (!/^[a-f0-9]{16,}$/i.test(id)) return null
  return join(homedir(), '.dsh', 'attachments', 'v1', 'objects', id.slice(0, 2), id)
}

/**
 * @param {object} mem
 * @param {string} [petId]
 * @returns {object[]}
 */
export function extractPetMessages(mem, petId = 'main') {
  if (!mem || typeof mem !== 'object') return []
  for (const entry of Object.values(mem)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const leaf = entry[petId]
    if (leaf && Array.isArray(leaf.messages)) return leaf.messages
    if (Array.isArray(entry.messages)) return entry.messages
  }
  return []
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 看屏/盯屏闸门写入的「附图」用户消息（不是用户真打的字）。 */
export function isGlanceInject(content) {
  return /【小蓝鲸已附上刚才的画面】/.test(String(content || ''))
}

export function formatTs(ts, now = Date.now()) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  try {
    const d = new Date(n)
    const cur = new Date(now)
    const pad = (x) => String(x).padStart(2, '0')
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    const sameDay = (a, b) => (
      a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate()
    )
    if (sameDay(d, cur)) return `今天 ${hm}`
    const y = new Date(cur)
    y.setDate(y.getDate() - 1)
    if (sameDay(d, y)) return `昨天 ${hm}`
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`
  } catch {
    return ''
  }
}

/** 展示用：截断过长提示；看屏注入只留用户原话。 */
export function displayContent(content, max = 400) {
  let s = String(content ?? '').trim()
  s = s.replace(/\s*\[身份\][\s\S]*$/, '').trim()
  const said = s.match(/用户刚说「([^」]+)」/)
  if (said) return said[1]
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s
}

/** 微信风格：间隔超过约 5 分钟插一条居中时间。 */
export function shouldShowTimeChip(prevTs, ts) {
  const a = Number(prevTs)
  const b = Number(ts)
  if (!Number.isFinite(b) || b <= 0) return false
  if (!Number.isFinite(a) || a <= 0) return true
  return Math.abs(b - a) >= 5 * 60 * 1000
}

const USER_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="10" fill="#6EB6FF"/>
  <circle cx="32" cy="24" r="12" fill="#FFFFFF"/>
  <ellipse cx="32" cy="54" rx="20" ry="16" fill="#FFFFFF"/>
</svg>`

/** 资源缺失时的兜底小蓝鲸头像。 */
const PET_AVATAR_SVG_FALLBACK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="10" fill="#DBEAFE"/>
  <ellipse cx="32" cy="34" rx="22" ry="16" fill="#3B82F6"/>
  <circle cx="26" cy="32" r="3" fill="#0F172A"/>
  <circle cx="38" cy="32" r="3" fill="#0F172A"/>
</svg>`

export function petAvatarAssetPath() {
  return join(HERE, '..', 'assets', 'avatar-pet.png')
}

function svgDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 优先用 assets/avatar-pet.png，内嵌 data URI，避免 file:// 裂图。 */
export async function resolvePetAvatarDataUri() {
  const fromPng = await fileToDataUri(petAvatarAssetPath(), 'image/png')
  if (fromPng) return fromPng
  return svgDataUri(PET_AVATAR_SVG_FALLBACK)
}

/**
 * @param {string | null} filePath
 * @param {string} [mime]
 * @returns {Promise<string | null>}
 */
export async function fileToDataUri(filePath, mime = 'image/png') {
  if (!filePath || !existsSync(filePath)) return null
  try {
    const buf = await readFile(filePath)
    if (!buf?.byteLength) return null
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 把看屏注入的附图挪到下一条小蓝鲸回复上，并去掉重复的「用户原话」气泡。
 * @param {object[]} messages
 * @returns {Promise<object[]>} 展示用行：{ role, content, ts, imageDataUris: string[] }
 */
export async function prepareChatRows(messages) {
  /** @type {object[]} */
  const rows = []
  /** @type {string[]} */
  let pendingImages = []

  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue
    const ts = m.ts
    const attId = m.image?.attachmentId
    let uri = null
    if (attId) {
      uri = await fileToDataUri(attachmentObjectPath(attId))
    }

    if (m.role !== 'assistant' && isGlanceInject(m.content)) {
      if (uri) pendingImages.push(uri)
      continue
    }

    if (m.role === 'assistant') {
      const images = pendingImages.splice(0, pendingImages.length)
      if (uri) images.push(uri)
      rows.push({
        role: 'assistant',
        content: displayContent(m.content),
        ts,
        imageDataUris: images,
      })
      continue
    }

    // 普通用户话；若紧跟着会被 inject 覆盖的同文案，仍保留这一条
    rows.push({
      role: 'user',
      content: displayContent(m.content),
      ts,
      imageDataUris: uri ? [uri] : [],
    })
  }

  // 末尾还有未接到的图：单独挂一条小蓝鲸「画面」气泡
  if (pendingImages.length) {
    rows.push({
      role: 'assistant',
      content: '',
      ts: rows.at(-1)?.ts,
      imageDataUris: pendingImages,
    })
  }
  return rows
}

/**
 * @param {{
 *   home: string,
 *   petId?: string,
 *   rounds?: number,
 *   memoryPath?: string,
 *   log?: (m: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, path?: string, count?: number, error?: string }>}
 */
export async function buildRecentChatHtml(options) {
  const home = options.home
  const petId = options.petId || 'main'
  const rounds = Math.max(1, Math.min(50, Number(options.rounds) || DEFAULT_RECENT_ROUNDS))
  const log = options.log ?? (() => {})
  const memoryPath = options.memoryPath || dshPetMemoryPath()

  let mem
  try {
    mem = JSON.parse(await readFile(memoryPath, 'utf8'))
  } catch (e) {
    return { ok: false, error: `读不到对话记忆：${e?.message ?? e}` }
  }

  const all = extractPetMessages(mem, petId).filter((m) => m && typeof m.content === 'string')
  const slice = all.slice(-(rounds * 2))
  if (!slice.length) {
    return { ok: false, error: '还没有聊天记录' }
  }

  await mkdir(recentChatAssetsDir(home), { recursive: true }).catch(() => {})

  const petAvatar = await resolvePetAvatarDataUri()
  const meAvatar = svgDataUri(USER_AVATAR_SVG)
  const rows = await prepareChatRows(slice)

  // 若整页没有任何附图，兜底挂上最近盯屏/看一眼落盘图
  const anyImg = rows.some((r) => r.imageDataUris?.length)
  if (!anyImg) {
    for (const p of [latestWatchPngPath(home), latestGlancePngPath(home)]) {
      const uri = await fileToDataUri(p)
      if (!uri) continue
      const lastPet = [...rows].reverse().find((r) => r.role === 'assistant')
      if (lastPet) lastPet.imageDataUris.push(uri)
      else {
        rows.push({
          role: 'assistant',
          content: '最近画面',
          ts: Date.now(),
          imageDataUris: [uri],
        })
      }
      break
    }
  }

  /** @type {string[]} */
  const blocks = []
  let prevTs = 0
  for (const row of rows) {
    const when = formatTs(row.ts)
    if (shouldShowTimeChip(prevTs, row.ts) && when) {
      blocks.push(`<div class="time-chip"><span>${escapeHtml(when)}</span></div>`)
    }
    prevTs = Number(row.ts) || prevTs

    const imgs = (row.imageDataUris || [])
      .map((u) => (
        `<button type="button" class="attach" data-zoom aria-label="查看大图">`
        + `<img src="${u}" alt="拼图" loading="lazy"/>`
        + `</button>`
      ))
      .join('')
    const text = escapeHtml(row.content || '')
    const bubbleInner = (text ? `<div class="text">${text}</div>` : '') + imgs
    if (!bubbleInner) continue

    if (row.role === 'assistant') {
      blocks.push(
        `<div class="row pet">`
        + `<img class="avatar" src="${petAvatar}" alt="小蓝鲸" width="42" height="42"/>`
        + `<div class="side"><div class="bubble">${bubbleInner}</div></div>`
        + `</div>`,
      )
    } else {
      blocks.push(
        `<div class="row me">`
        + `<div class="side"><div class="bubble">${bubbleInner}</div></div>`
        + `<img class="avatar" src="${meAvatar}" alt="我" width="42" height="42"/>`
        + `</div>`,
      )
    }
  }

  // 顶部快捷缩略（也内嵌，避免裂图）
  const shortcuts = []
  for (const [label, p] of [
    ['最近盯屏拼图', latestWatchPngPath(home)],
    ['最近看一眼', latestGlancePngPath(home)],
  ]) {
    const uri = await fileToDataUri(p)
    if (!uri) continue
    shortcuts.push(
      `<button type="button" class="quick-chip" data-zoom>`
      + `<img src="${uri}" alt=""/>`
      + `<span>${escapeHtml(label)}</span></button>`,
    )
  }

  void log
  void HERE

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>小蓝鲸 · 最近聊天</title>
<style>
  :root {
    --bg: #ededed;
    --bar: #f7f7f7;
    --pet-bubble: #ffffff;
    --me-bubble: #95ec69;
    --text: #111111;
    --muted: #8c8c8c;
    --avatar: 42px;
    --link: #576b95;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; }
  body.is-zooming { overflow: hidden; }
  header.bar {
    position: sticky; top: 0; z-index: 2;
    background: rgba(247,247,247,.92);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid #dcdcdc;
    padding: 14px 16px 12px;
    text-align: center;
  }
  header.bar h1 { margin: 0; font-size: 17px; font-weight: 600; }
  header.bar p { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
  .quick {
    max-width: 680px; margin: 0 auto;
    display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
    padding: 12px 12px 0;
  }
  .quick-chip {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--link); cursor: zoom-in;
    background: #fff; border-radius: 10px; padding: 6px 10px 6px 6px;
    border: 1px solid #e3e3e3; font-size: 12px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
    font: inherit;
  }
  .quick-chip img {
    width: 44px; height: 44px; object-fit: cover; border-radius: 6px; background: #f0f0f0;
    pointer-events: none;
  }
  main.chat {
    max-width: 680px; margin: 0 auto;
    padding: 14px 12px 36px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .time-chip { display: flex; justify-content: center; margin: 2px 0; }
  .time-chip span {
    font-size: 11px; color: #fff; background: rgba(0,0,0,.16);
    border-radius: 4px; padding: 2px 8px; line-height: 1.45;
  }
  .row { display: flex; align-items: flex-start; gap: 10px; width: 100%; }
  .row.me { justify-content: flex-end; }
  .avatar {
    width: var(--avatar); height: var(--avatar); flex: 0 0 var(--avatar);
    border-radius: 6px; object-fit: cover; background: #cfe8ff;
  }
  .side { max-width: min(74%, 440px); display: flex; flex-direction: column; }
  .row.me .side { align-items: flex-end; }
  .row.pet .side { align-items: flex-start; }
  .bubble {
    position: relative;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 15px; line-height: 1.55;
    word-break: break-word; white-space: pre-wrap;
    box-shadow: 0 1px 1px rgba(0,0,0,.05);
  }
  .row.pet .bubble { background: var(--pet-bubble); }
  .row.me .bubble { background: var(--me-bubble); }
  .bubble::before {
    content: ""; position: absolute; top: 12px; width: 0; height: 0;
    border-style: solid;
  }
  .row.pet .bubble::before {
    left: -6px;
    border-width: 5px 6px 5px 0;
    border-color: transparent var(--pet-bubble) transparent transparent;
  }
  .row.me .bubble::before {
    right: -6px;
    border-width: 5px 0 5px 6px;
    border-color: transparent transparent transparent var(--me-bubble);
  }
  .text + .attach { margin-top: 8px; }
  .attach {
    display: block; padding: 0; margin: 0; border: 0; background: transparent;
    cursor: zoom-in; border-radius: 6px; overflow: hidden;
  }
  .attach + .attach { margin-top: 8px; }
  .attach img {
    display: block; max-width: min(260px, 62vw);
    border-radius: 6px; background: #f3f3f3;
    pointer-events: none;
  }
  .lightbox {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; background: rgba(0,0,0,.82);
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity .18s ease, visibility .18s ease;
    cursor: zoom-out;
  }
  .lightbox.is-open {
    opacity: 1; visibility: visible; pointer-events: auto;
  }
  .lightbox img {
    max-width: min(96vw, 1200px);
    max-height: 92vh;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 8px 40px rgba(0,0,0,.45);
    transform: scale(.96);
    transition: transform .18s ease;
    cursor: zoom-out;
    background: #111;
  }
  .lightbox.is-open img { transform: scale(1); }
  .lightbox-hint {
    position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
    font-size: 12px; color: rgba(255,255,255,.72);
    pointer-events: none; user-select: none;
  }
</style>
</head>
<body>
<header class="bar">
  <h1>小蓝鲸</h1>
  <p>最近 ${rounds} 轮 · ${rows.length} 条 · 点图可放大</p>
</header>
${shortcuts.length ? `<div class="quick">${shortcuts.join('')}</div>` : ''}
<main class="chat">
${blocks.join('\n')}
</main>
<div class="lightbox" id="lightbox" hidden>
  <img alt="大图预览"/>
  <div class="lightbox-hint">点击空白处或按 Esc 关闭</div>
</div>
<script>
(function () {
  var box = document.getElementById('lightbox');
  var big = box.querySelector('img');
  function openZoom(src) {
    if (!src) return;
    big.src = src;
    box.hidden = false;
    requestAnimationFrame(function () { box.classList.add('is-open'); });
    document.body.classList.add('is-zooming');
  }
  function closeZoom() {
    box.classList.remove('is-open');
    document.body.classList.remove('is-zooming');
    setTimeout(function () {
      if (!box.classList.contains('is-open')) {
        box.hidden = true;
        big.removeAttribute('src');
      }
    }, 180);
  }
  document.addEventListener('click', function (e) {
    var hit = e.target.closest('[data-zoom]');
    if (hit && !box.contains(hit)) {
      e.preventDefault();
      var thumb = hit.querySelector('img') || (hit.tagName === 'IMG' ? hit : null);
      openZoom(thumb && (thumb.currentSrc || thumb.src));
      return;
    }
    if (box.classList.contains('is-open') && (e.target === box || e.target === big)) closeZoom();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeZoom();
  });
})();
</script>
</body>
</html>`

  const out = recentChatHtmlPath(home)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, html, 'utf8')
  return { ok: true, path: out, count: rows.length }
}

/** Windows：用默认浏览器打开本地 HTML。 */
export function openPathDefault(filePath) {
  return new Promise((resolve) => {
    const child = spawn('cmd', ['/c', 'start', '', filePath], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    child.on('error', () => resolve(false))
    setTimeout(() => resolve(true), 200)
  })
}

/**
 * @param {{ home: string, petId?: string, rounds?: number, memoryPath?: string, log?: (m: string) => void }} options
 */
export async function openRecentChat(options) {
  const built = await buildRecentChatHtml(options)
  if (!built.ok || !built.path) return built
  const opened = await openPathDefault(built.path)
  if (!opened) return { ok: false, error: '无法打开浏览器', path: built.path, count: built.count }
  return built
}
