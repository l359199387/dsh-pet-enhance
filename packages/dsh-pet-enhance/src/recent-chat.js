/**
 * 从 dsh-pet memory.json 生成「最近聊天」HTML，用系统浏览器打开。
 * 桌面双击对话只是输入框，没有历史列表——靠这个补上。
 *
 * 这是落盘快照（非 live SSR）：打开后监视 memory.json，有更新就回写同一 HTML，
 * 浏览器 F5 才能看到最新；只刷新旧标签、宿主又没在跑监视时，内容不会变。
 *
 * 分页：先显示最新一页；滚到顶部再拼更早一页（微信上滑回看）。
 * 附图落到 cache；头像用 data URI，避免 file:// 裂图。
 *
 * @module src/recent-chat.js
 */

import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { latestGlancePngPath, latestWatchPngPath } from './chat-bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** @deprecated 兼容旧参数；现表示每页条数 */
export const DEFAULT_RECENT_ROUNDS = 12
export const DEFAULT_PAGE_SIZE = 12
/** 最多带入多少条展示行（防 HTML 过大） */
export const MAX_CHAT_ROWS = 300

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

/** 优先用 assets/avatar-pet.png，内嵌 data URI，避免 file:// 裂图。 */
export async function resolvePetAvatarDataUri() {
  const fromPng = await fileToDataUri(petAvatarAssetPath(), 'image/png')
  if (fromPng) return fromPng
  return svgDataUri(PET_AVATAR_SVG_FALLBACK)
}

/**
 * 把看屏注入的附图挪到下一条小蓝鲸回复上，并去掉重复的「用户原话」气泡。
 * @param {object[]} messages
 * @param {{ resolveImage?: (attachmentId: string) => Promise<string | null> }} [opts]
 * @returns {Promise<object[]>} 展示用行：{ role, content, ts, images: string[] }
 */
export async function prepareChatRows(messages, opts = {}) {
  const resolveImage = opts.resolveImage || (async (attachmentId) => (
    fileToDataUri(attachmentObjectPath(attachmentId))
  ))
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
      try {
        uri = await resolveImage(attId)
      } catch {
        uri = null
      }
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
        images,
      })
      continue
    }

    rows.push({
      role: 'user',
      content: displayContent(m.content),
      ts,
      images: uri ? [uri] : [],
    })
  }

  if (pendingImages.length) {
    rows.push({
      role: 'assistant',
      content: '',
      ts: rows.at(-1)?.ts,
      images: pendingImages,
    })
  }
  return rows
}

/** 按时间顺序切页：pages[0] 最早，pages[at(-1)] 最新。 */
export function chunkPages(rows, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.max(1, Math.min(50, Number(pageSize) || DEFAULT_PAGE_SIZE))
  /** @type {object[][]} */
  const pages = []
  for (let i = 0; i < rows.length; i += size) {
    pages.push(rows.slice(i, i + size))
  }
  return pages
}

/**
 * 附件落到 cache，返回相对 HTML 的路径（避免 data URI 撑爆多页 JSON，也避开 copy EPERM）。
 * @param {string} home
 * @param {string} attachmentId
 */
export async function materializeAttachment(home, attachmentId) {
  const src = attachmentObjectPath(attachmentId)
  if (!src || !existsSync(src)) return null
  const id = String(attachmentId).replace(/^sha256:/i, '')
  const assets = recentChatAssetsDir(home)
  await mkdir(assets, { recursive: true })
  const name = `att-${id.slice(0, 20)}.png`
  const dest = join(assets, name)
  if (!existsSync(dest)) {
    await writeFile(dest, await readFile(src))
  }
  // 绝对 file://，避免部分浏览器对 file 页相对子路径拦图
  return pathToFileURL(dest).href
}

async function materializeLocalPng(home, filePath, name) {
  if (!filePath || !existsSync(filePath)) return null
  const assets = recentChatAssetsDir(home)
  await mkdir(assets, { recursive: true })
  const dest = join(assets, name)
  try {
    await writeFile(dest, await readFile(filePath))
    return pathToFileURL(dest).href
  } catch {
    return null
  }
}

/**
 * @param {{
 *   home: string,
 *   petId?: string,
 *   rounds?: number,
 *   pageSize?: number,
 *   maxRows?: number,
 *   memoryPath?: string,
 *   log?: (m: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, path?: string, count?: number, pages?: number, error?: string }>}
 */
export async function buildRecentChatHtml(options) {
  const home = options.home
  const petId = options.petId || 'main'
  const pageSize = Math.max(
    1,
    Math.min(50, Number(options.pageSize) || Number(options.rounds) || DEFAULT_PAGE_SIZE),
  )
  const maxRows = Math.max(
    pageSize,
    Math.min(1000, Number(options.maxRows) || MAX_CHAT_ROWS),
  )
  const log = options.log ?? (() => {})
  const memoryPath = options.memoryPath || dshPetMemoryPath()

  let mem
  try {
    mem = JSON.parse(await readFile(memoryPath, 'utf8'))
  } catch (e) {
    return { ok: false, error: `读不到对话记忆：${e?.message ?? e}` }
  }

  const all = extractPetMessages(mem, petId).filter((m) => m && typeof m.content === 'string')
  if (!all.length) {
    return { ok: false, error: '还没有聊天记录' }
  }

  await mkdir(recentChatAssetsDir(home), { recursive: true }).catch(() => {})

  const petAvatar = await resolvePetAvatarDataUri()
  const meAvatar = svgDataUri(USER_AVATAR_SVG)
  let rows = await prepareChatRows(all, {
    resolveImage: (id) => materializeAttachment(home, id),
  })
  if (rows.length > maxRows) {
    rows = rows.slice(-maxRows)
  }

  // 若整页没有任何附图，兜底挂上最近盯屏/看一眼落盘图
  const anyImg = rows.some((r) => r.images?.length)
  if (!anyImg) {
    for (const [name, p] of [
      ['watch-latest.png', latestWatchPngPath(home)],
      ['glance-latest.png', latestGlancePngPath(home)],
    ]) {
      const uri = await materializeLocalPng(home, p, name)
      if (!uri) continue
      const lastPet = [...rows].reverse().find((r) => r.role === 'assistant')
      if (lastPet) lastPet.images.push(uri)
      else {
        rows.push({
          role: 'assistant',
          content: '最近画面',
          ts: Date.now(),
          images: [uri],
        })
      }
      break
    }
  }

  const pages = chunkPages(rows, pageSize)
  if (!pages.length) {
    return { ok: false, error: '还没有聊天记录' }
  }

  // 顶部快捷缩略
  const shortcuts = []
  for (const [label, name, p] of [
    ['最近盯屏拼图', 'watch-latest.png', latestWatchPngPath(home)],
    ['最近看一眼', 'glance-latest.png', latestGlancePngPath(home)],
  ]) {
    const uri = await materializeLocalPng(home, p, name)
    if (!uri) continue
    shortcuts.push(
      `<button type="button" class="quick-chip" data-zoom>`
      + `<img src="${uri}" alt=""/>`
      + `<span>${escapeHtml(label)}</span></button>`,
    )
  }

  const payload = {
    pageSize,
    total: rows.length,
    pageCount: pages.length,
    petAvatar,
    meAvatar,
    pages,
  }
  const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c')

  void log
  void HERE

  const generatedAt = formatTs(Date.now(), Date.now()) || new Date().toLocaleString('zh-CN', { hour12: false })
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
<meta http-equiv="Pragma" content="no-cache"/>
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
  header.bar p.hint { margin-top: 6px; line-height: 1.45; max-width: 36em; margin-left: auto; margin-right: auto; }
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
    padding: 8px 12px 36px;
    display: flex; flex-direction: column; gap: 10px;
  }
  #chat-list {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  #bottom-anchor { width: 100%; height: 1px; flex: 0 0 1px; }
  .load-tip {
    text-align: center; font-size: 12px; color: var(--muted);
    padding: 10px 0 4px; min-height: 28px;
  }
  .load-tip.is-busy { color: var(--link); }
  .time-chip { display: flex; justify-content: center; margin: 2px 0; }
  .time-chip span {
    font-size: 11px; color: #fff; background: rgba(0,0,0,.16);
    border-radius: 4px; padding: 2px 8px; line-height: 1.45;
  }
  .row {
    display: flex; align-items: flex-start; gap: 10px; width: 100%;
    content-visibility: auto;
    contain-intrinsic-size: auto 72px;
  }
  .row.me { justify-content: flex-end; }
  .avatar {
    width: var(--avatar); height: var(--avatar); flex: 0 0 var(--avatar);
    border-radius: 6px; background: #cfe8ff center/cover no-repeat;
  }
  .avatar.pet { background-image: url("${petAvatar}"); }
  .avatar.me { background-image: url("${meAvatar}"); }
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
    padding: 16px; background: rgba(0,0,0,.86);
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity .18s ease, visibility .18s ease;
    cursor: default;
    overflow: hidden;
  }
  .lightbox.is-open {
    opacity: 1; visibility: visible; pointer-events: auto;
  }
  .lightbox-stage {
    position: relative;
    max-width: 100%; max-height: 100%;
    display: flex; align-items: center; justify-content: center;
  }
  .lightbox img {
    max-width: min(96vw, 1200px);
    max-height: 86vh;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 8px 40px rgba(0,0,0,.45);
    background: #111;
    transform-origin: center center;
    will-change: transform;
    user-select: none;
    -webkit-user-drag: none;
  }
  .lightbox.is-panning img { cursor: grabbing; }
  .lightbox:not(.is-panning) img { cursor: grab; }
  .lightbox-hud {
    position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    pointer-events: none; user-select: none; text-align: center;
  }
  .lightbox-meta {
    font-size: 12px; color: rgba(255,255,255,.88);
    background: rgba(0,0,0,.35); border-radius: 999px; padding: 3px 10px;
  }
  .lightbox-hint {
    font-size: 11px; color: rgba(255,255,255,.62); line-height: 1.45;
    max-width: 92vw;
  }
  .lightbox-hint kbd {
    display: inline-block; padding: 0 5px; margin: 0 1px;
    border: 1px solid rgba(255,255,255,.28); border-radius: 3px;
    font: 11px/1.4 Consolas, "Segoe UI", monospace;
    color: #fff;
  }
</style>
</head>
<body>
<header class="bar">
  <h1>小蓝鲸</h1>
  <p id="header-sub">共 ${rows.length} 条 · ${pages.length} 页 · ${escapeHtml(generatedAt)} 生成</p>
  <p class="hint">对话有更新时宿主会回写本页；按 F5 看最新。仍旧则再点宠物右键「最近聊天内容」。</p>
</header>
${shortcuts.length ? `<div class="quick">${shortcuts.join('')}</div>` : ''}
<main class="chat">
  <div class="load-tip" id="load-tip">上滑可查看更早聊天</div>
  <div id="top-sentinel" aria-hidden="true"></div>
  <div id="chat-list"></div>
  <div id="bottom-anchor" aria-hidden="true"></div>
</main>
<div class="lightbox" id="lightbox" hidden>
  <div class="lightbox-stage"><img alt="大图预览"/></div>
  <div class="lightbox-hud">
    <div class="lightbox-meta" id="lightbox-meta">1 / 1 · 100%</div>
    <div class="lightbox-hint">
      <kbd>Esc</kbd>关闭 · <kbd>+</kbd><kbd>-</kbd>缩放 · <kbd>0</kbd>复位 ·
      <kbd>←</kbd><kbd>→</kbd>切图 · <kbd>R</kbd>旋转 · 滚轮缩放 · 拖拽平移
    </div>
  </div>
</div>
<script type="application/json" id="chat-data">${payloadJson}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('chat-data').textContent);
  var pages = data.pages || [];
  var list = document.getElementById('chat-list');
  var tip = document.getElementById('load-tip');
  var sentinel = document.getElementById('top-sentinel');
  var sub = document.getElementById('header-sub');
  var cursor = pages.length; // 下一页要加载的是 cursor-1
  var loading = false;
  var armed = false; // 吸底完成前不启用顶部加载
  var sticking = false; // 打开时吸底，等布局/图片稳定
  var io = null;
  var bottomAnchor = document.getElementById('bottom-anchor');

  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}

  function scrollToBottom() {
    if (bottomAnchor && bottomAnchor.scrollIntoView) {
      bottomAnchor.scrollIntoView({ block: 'end', behavior: 'auto' });
    }
    var top = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    window.scrollTo(0, top);
  }

  function enableTopLoader() {
    armed = true;
    updateTip();
    if (io && cursor > 0) io.observe(sentinel);
  }

  function stickBottomOnOpen() {
    sticking = true;
    var tries = 0;
    var imgs = list.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i].complete) {
        imgs[i].addEventListener('load', scrollToBottom, { once: true });
        imgs[i].addEventListener('error', scrollToBottom, { once: true });
      }
    }
    function tick() {
      scrollToBottom();
      tries += 1;
      if (tries < 24) {
        requestAnimationFrame(tick);
      } else {
        sticking = false;
        scrollToBottom();
        enableTopLoader();
      }
    }
    requestAnimationFrame(tick);
    setTimeout(function () {
      if (!sticking) return;
      sticking = false;
      scrollToBottom();
      enableTopLoader();
    }, 600);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTs(ts) {
    var n = Number(ts);
    if (!isFinite(n) || n <= 0) return '';
    var d = new Date(n);
    var cur = new Date();
    var pad = function (x) { return String(x).padStart(2, '0'); };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var same = d.getFullYear() === cur.getFullYear() && d.getMonth() === cur.getMonth() && d.getDate() === cur.getDate();
    if (same) return '今天 ' + hm;
    var y = new Date(cur); y.setDate(y.getDate() - 1);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天 ' + hm;
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function shouldTime(prev, ts) {
    var a = Number(prev), b = Number(ts);
    if (!isFinite(b) || b <= 0) return false;
    if (!isFinite(a) || a <= 0) return true;
    return Math.abs(b - a) >= 5 * 60 * 1000;
  }

  function rowHtml(row) {
    var imgs = (row.images || []).map(function (u) {
      return '<button type="button" class="attach" data-zoom aria-label="查看大图">'
        + '<img src="' + esc(u) + '" alt="拼图" loading="lazy" decoding="async"/></button>';
    }).join('');
    var text = esc(row.content || '');
    var inner = (text ? '<div class="text">' + text + '</div>' : '') + imgs;
    if (!inner) return '';
    // 头像用 CSS 背景（整页只嵌一份），避免每条消息重复塞入巨型 base64
    if (row.role === 'assistant') {
      return '<div class="row pet">'
        + '<div class="avatar pet" role="img" aria-label="小蓝鲸"></div>'
        + '<div class="side"><div class="bubble">' + inner + '</div></div></div>';
    }
    return '<div class="row me">'
      + '<div class="side"><div class="bubble">' + inner + '</div></div>'
      + '<div class="avatar me" role="img" aria-label="我"></div></div>';
  }

  function pageHtml(pageRows, seedTs) {
    var html = '';
    var prev = seedTs;
    for (var i = 0; i < pageRows.length; i++) {
      var row = pageRows[i];
      var when = formatTs(row.ts);
      if (shouldTime(prev, row.ts) && when) {
        html += '<div class="time-chip"><span>' + esc(when) + '</span></div>';
      }
      html += rowHtml(row);
      prev = Number(row.ts) || prev;
    }
    return { html: html, lastTs: prev };
  }

  function updateTip() {
    var shownPages = pages.length - cursor;
    if (cursor <= 0) {
      tip.textContent = '已经到最早了';
      tip.className = 'load-tip';
    } else if (loading) {
      tip.textContent = '正在加载更早消息…';
      tip.className = 'load-tip is-busy';
    } else if (!armed) {
      tip.textContent = '继续上滑可加载更早 · 已显示 ' + shownPages + '/' + pages.length + ' 页';
      tip.className = 'load-tip';
    } else {
      tip.textContent = '上滑加载更早 · 已显示 ' + shownPages + '/' + pages.length + ' 页';
      tip.className = 'load-tip';
    }
    if (sub) {
      sub.textContent = '共 ' + data.total + ' 条 · 已加载 ' + shownPages + '/' + pages.length + ' 页 · 上滑看更早';
    }
  }

  function prependPage() {
    if (loading || !armed || cursor <= 0) { updateTip(); return; }
    loading = true;
    armed = false;
    if (io) io.unobserve(sentinel);
    updateTip();

    var next = cursor - 1;
    var pageRows = pages[next] || [];
    var built = pageHtml(pageRows, 0);
    var holder = document.createElement('div');
    holder.innerHTML = built.html;
    var frag = document.createDocumentFragment();
    while (holder.firstChild) frag.appendChild(holder.firstChild);

    var prevHeight = document.documentElement.scrollHeight;
    var prevTop = window.scrollY || document.documentElement.scrollTop || 0;
    list.insertBefore(frag, list.firstChild);
    var newHeight = document.documentElement.scrollHeight;
    window.scrollTo(0, prevTop + (newHeight - prevHeight));

    cursor = next;
    loading = false;
    updateTip();

    // 离开顶部后再允许加载下一页，避免停在顶部连环卡顿加载
    var rearm = function () {
      if ((window.scrollY || 0) > 120) {
        window.removeEventListener('scroll', rearm);
        armed = true;
        updateTip();
        if (io && cursor > 0) io.observe(sentinel);
      }
    };
    window.addEventListener('scroll', rearm, { passive: true });
    setTimeout(rearm, 500);
  }

  function loadLatest() {
    if (!pages.length) return;
    cursor = pages.length - 1;
    var built = pageHtml(pages[cursor], 0);
    list.innerHTML = built.html;
    updateTip();
    stickBottomOnOpen();
  }

  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      if (sticking) return;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          prependPage();
          break;
        }
      }
    }, { root: null, rootMargin: '40px 0px 0px 0px', threshold: 0 });
  } else {
    window.addEventListener('scroll', function () {
      if (sticking) return;
      if ((window.scrollY || 0) < 40) prependPage();
    }, { passive: true });
  }

  loadLatest();

  // —— 灯箱 ——
  var box = document.getElementById('lightbox');
  var stage = box.querySelector('.lightbox-stage');
  var big = stage.querySelector('img');
  var meta = document.getElementById('lightbox-meta');
  var glist = [];
  var gindex = 0;
  var scale = 1, rotate = 0, tx = 0, ty = 0;
  var dragging = false, lastX = 0, lastY = 0;
  var MIN = 0.4, MAX = 6;

  function gallery() {
    var out = [], seen = Object.create(null);
    document.querySelectorAll('[data-zoom] img').forEach(function (img) {
      var src = img.currentSrc || img.src;
      if (!src || seen[src]) return;
      seen[src] = 1;
      out.push(src);
    });
    return out;
  }
  function applyTransform(animate) {
    big.style.transition = animate ? 'transform .16s ease' : 'none';
    big.style.transform = 'translate(' + tx + 'px,' + ty + 'px) rotate(' + rotate + 'deg) scale(' + scale + ')';
    meta.textContent = (gindex + 1) + ' / ' + Math.max(glist.length, 1) + ' · ' + Math.round(scale * 100) + '%';
  }
  function resetView(animate) {
    scale = 1; rotate = 0; tx = 0; ty = 0;
    applyTransform(animate !== false);
  }
  function showAt(i, animate) {
    if (!glist.length) return;
    gindex = (i + glist.length) % glist.length;
    big.src = glist[gindex];
    resetView(animate);
  }
  function openZoom(src) {
    if (!src) return;
    glist = gallery();
    var i = glist.indexOf(src);
    if (i < 0) { glist.push(src); i = glist.length - 1; }
    gindex = i;
    box.hidden = false;
    showAt(gindex, false);
    requestAnimationFrame(function () { box.classList.add('is-open'); });
    document.body.classList.add('is-zooming');
  }
  function closeZoom() {
    box.classList.remove('is-open');
    document.body.classList.remove('is-zooming');
    dragging = false;
    box.classList.remove('is-panning');
    setTimeout(function () {
      if (!box.classList.contains('is-open')) {
        box.hidden = true;
        big.removeAttribute('src');
        glist = [];
      }
    }, 180);
  }
  function zoomBy(factor, cx, cy) {
    var next = Math.min(MAX, Math.max(MIN, scale * factor));
    if (next === scale) return;
    if (typeof cx === 'number' && typeof cy === 'number') {
      var rect = big.getBoundingClientRect();
      var mx = cx - (rect.left + rect.width / 2);
      var my = cy - (rect.top + rect.height / 2);
      var k = next / scale;
      tx = mx - (mx - tx) * k;
      ty = my - (my - ty) * k;
    }
    scale = next;
    applyTransform(true);
  }
  function isOpen() { return box.classList.contains('is-open'); }

  document.addEventListener('click', function (e) {
    var hit = e.target.closest('[data-zoom]');
    if (hit && !box.contains(hit)) {
      e.preventDefault();
      var thumb = hit.querySelector('img') || (hit.tagName === 'IMG' ? hit : null);
      openZoom(thumb && (thumb.currentSrc || thumb.src));
      return;
    }
    if (isOpen() && (e.target === box || e.target === stage)) closeZoom();
  });
  big.addEventListener('dblclick', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (scale > 1.05) resetView(true);
    else zoomBy(2, e.clientX, e.clientY);
  });
  big.addEventListener('pointerdown', function (e) {
    if (!isOpen() || e.button !== 0) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    box.classList.add('is-panning');
    big.setPointerCapture(e.pointerId);
  });
  big.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    applyTransform(false);
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    box.classList.remove('is-panning');
    try { big.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  big.addEventListener('pointerup', endDrag);
  big.addEventListener('pointercancel', endDrag);
  box.addEventListener('wheel', function (e) {
    if (!isOpen()) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });
  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); closeZoom(); return; }
    if (k === '+' || k === '=' || k === ']') { e.preventDefault(); zoomBy(1.2); return; }
    if (k === '-' || k === '_') { e.preventDefault(); zoomBy(1 / 1.2); return; }
    if (k === '0') { e.preventDefault(); resetView(true); return; }
    if (k === 'r' || k === 'R') { e.preventDefault(); rotate = (rotate + 90) % 360; applyTransform(true); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); showAt(gindex - 1, false); return; }
    if (k === 'ArrowRight') { e.preventDefault(); showAt(gindex + 1, false); return; }
    if (k === 'ArrowUp') { e.preventDefault(); ty += 40; applyTransform(true); return; }
    if (k === 'ArrowDown') { e.preventDefault(); ty -= 40; applyTransform(true); return; }
  });
})();
</script>
</body>
</html>`

  const out = recentChatHtmlPath(home)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, html, 'utf8')
  return { ok: true, path: out, count: rows.length, pages: pages.length }
}

/** Windows：用默认浏览器打开本地 HTML（带 cache-bust，减少旧标签缓存）。 */
export function openPathDefault(filePath) {
  return new Promise((resolve) => {
    let target = filePath
    try {
      target = `${pathToFileURL(filePath).href}?t=${Date.now()}`
    } catch { /* 退回裸路径 */ }
    const child = spawn('cmd', ['/c', 'start', '', target], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    child.on('error', () => resolve(false))
    setTimeout(() => resolve(true), 200)
  })
}

const LIVE_IDLE_MS = 30 * 60 * 1000

/** @type {null | { dispose: () => void, arm: (opts: object) => void }} */
let liveSync = null

/**
 * 打开「最近聊天」后监视 memory.json，有改动就回写同一 HTML，便于浏览器 F5。
 * @param {{ home: string, petId?: string, rounds?: number, pageSize?: number, maxRows?: number, memoryPath?: string, log?: (m: string) => void }} options
 */
export function armRecentChatLiveSync(options) {
  const log = options.log ?? (() => {})
  const memoryPath = options.memoryPath || dshPetMemoryPath()

  if (liveSync) {
    liveSync.arm(options)
    return liveSync
  }

  /** @type {import('node:fs').FSWatcher | null} */
  let watcher = null
  let debounceTimer = null
  let idleTimer = null
  let building = false
  let pending = false
  /** @type {object} */
  let opts = options

  function clearDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function stopWatcher() {
    clearDebounce()
    if (watcher) {
      try { watcher.close() } catch { /* ignore */ }
      watcher = null
    }
  }

  function bumpIdle() {
    clearIdle()
    idleTimer = setTimeout(() => {
      idleTimer = null
      stopWatcher()
      log('最近聊天实时同步已闲置停止（再打开菜单会重新监视）')
    }, LIVE_IDLE_MS)
  }

  async function rebuild() {
    if (building) {
      pending = true
      return
    }
    building = true
    try {
      const r = await buildRecentChatHtml(opts)
      if (r.ok) log(`最近聊天已同步落盘：${r.count} 条`)
      else log(`最近聊天同步跳过：${r.error || 'unknown'}`)
    } catch (e) {
      log(`最近聊天同步失败：${e?.message ?? e}`)
    } finally {
      building = false
      if (pending) {
        pending = false
        schedule()
      }
    }
  }

  function schedule() {
    bumpIdle()
    clearDebounce()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      rebuild().catch(() => {})
    }, 450)
  }

  function ensureWatcher() {
    if (watcher) return
    try {
      watcher = watch(memoryPath, { persistent: false }, () => schedule())
      if (typeof watcher.on === 'function') {
        watcher.on('error', () => stopWatcher())
      }
      log(`最近聊天开始监视：${memoryPath}`)
    } catch (e) {
      log(`最近聊天监视失败：${e?.message ?? e}`)
    }
  }

  liveSync = {
    arm(next) {
      opts = next || opts
      ensureWatcher()
      bumpIdle()
    },
    dispose() {
      clearIdle()
      stopWatcher()
      liveSync = null
    },
  }
  liveSync.arm(options)
  return liveSync
}

/** 插件卸载时停掉监视。 */
export function disposeRecentChatLiveSync() {
  try { liveSync?.dispose() } catch { /* ignore */ }
  liveSync = null
}

/**
 * @param {{ home: string, petId?: string, rounds?: number, pageSize?: number, maxRows?: number, memoryPath?: string, log?: (m: string) => void }} options
 */
export async function openRecentChat(options) {
  const built = await buildRecentChatHtml(options)
  if (!built.ok || !built.path) return built
  armRecentChatLiveSync(options)
  const opened = await openPathDefault(built.path)
  if (!opened) return { ok: false, error: '无法打开浏览器', path: built.path, count: built.count }
  return built
}
