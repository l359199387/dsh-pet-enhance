/**
 * 从 dsh-pet memory.json 生成「最近聊天」HTML，用系统浏览器打开。
 * 桌面双击对话只是输入框，没有历史列表——靠这个补上。
 *
 * @module src/recent-chat.js
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
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
  // 形状：{ main: { main: { messages: [...] } } } 或 { entry: { petId: { messages } } }
  for (const entry of Object.values(mem)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const leaf = entry[petId]
    if (leaf && Array.isArray(leaf.messages)) return leaf.messages
    // 兼容单层
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

function formatTs(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

/** 展示用：截断过长提示；看屏注入只留用户原话（气泡里不塞模型说明）。 */
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

const USER_AVATAR_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="我">
  <rect width="64" height="64" rx="10" fill="#6EB6FF"/>
  <circle cx="32" cy="24" r="12" fill="#FFFFFF"/>
  <ellipse cx="32" cy="54" rx="20" ry="16" fill="#FFFFFF"/>
</svg>
`

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

  const assets = recentChatAssetsDir(home)
  await mkdir(assets, { recursive: true })

  // 头像：小蓝鲸用仓库 pet.svg；用户用内嵌简图
  const petSrc = join(HERE, '..', 'assets', 'pet.svg')
  const petDest = join(assets, 'avatar-pet.svg')
  const userDest = join(assets, 'avatar-me.svg')
  try {
    if (existsSync(petSrc)) await copyFile(petSrc, petDest)
    await writeFile(userDest, USER_AVATAR_SVG, 'utf8')
  } catch (e) {
    log(`recent-chat 头像准备失败：${e?.message ?? e}`)
  }
  const petAvatar = existsSync(petDest)
    ? './recent-chat-assets/avatar-pet.svg'
    : ''
  const meAvatar = './recent-chat-assets/avatar-me.svg'

  /** @type {string[]} */
  const blocks = []
  let imgN = 0
  let prevTs = 0
  for (const m of slice) {
    const isPet = m.role === 'assistant'
    const when = formatTs(m.ts)
    if (shouldShowTimeChip(prevTs, m.ts) && when) {
      blocks.push(`<div class="time-chip"><span>${escapeHtml(when)}</span></div>`)
    }
    prevTs = Number(m.ts) || prevTs

    let imgHtml = ''
    const attId = m.image?.attachmentId
    if (attId) {
      const srcPath = attachmentObjectPath(attId)
      if (srcPath && existsSync(srcPath)) {
        imgN += 1
        const dest = join(assets, `img-${imgN}.png`)
        try {
          await copyFile(srcPath, dest)
          imgHtml = `<div class="attach"><img src="./recent-chat-assets/img-${imgN}.png" alt="附图"/></div>`
        } catch (e) {
          log(`recent-chat 拷图失败：${e?.message ?? e}`)
        }
      }
    }

    const text = escapeHtml(displayContent(m.content))
    const bubbleInner = (text ? `<div class="text">${text}</div>` : '') + imgHtml
    if (isPet) {
      blocks.push(
        `<div class="row pet">`
        + `<img class="avatar" src="${petAvatar || meAvatar}" alt="小蓝鲸"/>`
        + `<div class="side">`
        + `<div class="name">小蓝鲸</div>`
        + `<div class="bubble">${bubbleInner || '<div class="text">（空）</div>'}</div>`
        + `</div></div>`,
      )
    } else {
      blocks.push(
        `<div class="row me">`
        + `<div class="side">`
        + `<div class="name">我</div>`
        + `<div class="bubble">${bubbleInner || '<div class="text">（空）</div>'}</div>`
        + `</div>`
        + `<img class="avatar" src="${meAvatar}" alt="我"/>`
        + `</div>`,
      )
    }
  }

  // 顶部快捷：最新盯屏/看屏落盘图
  const shortcuts = []
  for (const [label, p] of [
    ['最近盯屏拼图', latestWatchPngPath(home)],
    ['最近看一眼', latestGlancePngPath(home)],
  ]) {
    if (existsSync(p)) {
      const name = label === '最近盯屏拼图' ? 'watch-latest.png' : 'glance-latest.png'
      const dest = join(assets, name)
      try {
        await copyFile(p, dest)
        shortcuts.push(
          `<a class="quick-chip" href="./recent-chat-assets/${name}" target="_blank">${escapeHtml(label)}</a>`,
        )
      } catch { /* ignore */ }
    }
  }

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
    --muted: #888888;
    --avatar: 42px;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; }
  header.bar {
    position: sticky; top: 0; z-index: 2;
    background: var(--bar);
    border-bottom: 1px solid #d9d9d9;
    padding: 12px 16px 10px;
    text-align: center;
  }
  header.bar h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: 0.02em; }
  header.bar p { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
  .quick {
    display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
    padding: 10px 12px 0;
  }
  .quick-chip {
    font-size: 12px; color: #576b95; text-decoration: none;
    background: #fff; border-radius: 999px; padding: 4px 10px;
    border: 1px solid #e0e0e0;
  }
  main.chat {
    max-width: 720px; margin: 0 auto;
    padding: 12px 10px 28px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .time-chip { display: flex; justify-content: center; }
  .time-chip span {
    font-size: 11px; color: #fff; background: rgba(0,0,0,.18);
    border-radius: 4px; padding: 2px 7px; line-height: 1.4;
  }
  .row { display: flex; align-items: flex-start; gap: 10px; width: 100%; }
  .row.me { flex-direction: row; justify-content: flex-end; }
  .avatar {
    width: var(--avatar); height: var(--avatar); flex: 0 0 var(--avatar);
    border-radius: 6px; object-fit: cover; background: #cfe8ff;
    box-shadow: 0 0 0 1px rgba(0,0,0,.04);
  }
  .side { max-width: min(72%, 420px); display: flex; flex-direction: column; gap: 4px; }
  .row.me .side { align-items: flex-end; }
  .row.pet .side { align-items: flex-start; }
  .name { font-size: 12px; color: var(--muted); line-height: 1; padding: 0 2px; }
  .bubble {
    position: relative;
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 15px; line-height: 1.5;
    word-break: break-word; white-space: pre-wrap;
    box-shadow: 0 1px 1px rgba(0,0,0,.04);
  }
  .row.pet .bubble { background: var(--pet-bubble); }
  .row.me .bubble { background: var(--me-bubble); }
  .bubble::before {
    content: ""; position: absolute; top: 12px;
    border: 6px solid transparent;
  }
  .row.pet .bubble::before {
    left: -11px; border-right-color: var(--pet-bubble);
  }
  .row.me .bubble::before {
    right: -11px; border-left-color: var(--me-bubble);
  }
  .text { margin: 0; }
  .attach { margin-top: 8px; }
  .attach:first-child { margin-top: 0; }
  .attach img {
    display: block; max-width: min(240px, 58vw);
    border-radius: 4px; cursor: zoom-in;
  }
</style>
</head>
<body>
<header class="bar">
  <h1>小蓝鲸</h1>
  <p>最近 ${rounds} 轮 · ${slice.length} 条</p>
</header>
${shortcuts.length ? `<div class="quick">${shortcuts.join('')}</div>` : ''}
<main class="chat">
${blocks.join('\n')}
</main>
</body>
</html>`

  const out = recentChatHtmlPath(home)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, html, 'utf8')
  return { ok: true, path: out, count: slice.length }
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
    // start 很快返回
    setTimeout(() => resolve(true), 200)
  })
}

/**
 * 生成并打开最近聊天页。
 * @param {{ home: string, petId?: string, rounds?: number, memoryPath?: string, log?: (m: string) => void }} options
 */
export async function openRecentChat(options) {
  const built = await buildRecentChatHtml(options)
  if (!built.ok || !built.path) return built
  const opened = await openPathDefault(built.path)
  if (!opened) return { ok: false, error: '无法打开浏览器', path: built.path, count: built.count }
  return built
}
