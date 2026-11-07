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

/** 展示用：截断过长的跟催提示；看屏注入优先露出用户原话。 */
export function displayContent(content, max = 400) {
  let s = String(content ?? '').trim()
  // 折叠人格尾巴
  s = s.replace(/\s*\[身份\][\s\S]*$/, '').trim()
  const said = s.match(/用户刚说「([^」]+)」/)
  if (said) {
    const detail = s
      .replace(/^【小蓝鲸已附上刚才的画面】/, '')
      .replace(/用户刚说「[^」]+」。?/, '')
      .trim()
    s = `「${said[1]}」\n${detail}`
  }
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s
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

  const assets = recentChatAssetsDir(home)
  await mkdir(assets, { recursive: true })

  /** @type {string[]} */
  const blocks = []
  let imgN = 0
  for (const m of slice) {
    const role = m.role === 'assistant' ? '小蓝鲸' : '你'
    const cls = m.role === 'assistant' ? 'assistant' : 'user'
    const when = formatTs(m.ts)
    let imgHtml = ''
    const attId = m.image?.attachmentId
    if (attId) {
      const srcPath = attachmentObjectPath(attId)
      if (srcPath && existsSync(srcPath)) {
        imgN += 1
        const dest = join(assets, `img-${imgN}.png`)
        try {
          await copyFile(srcPath, dest)
          imgHtml = `<div class="img"><img src="./recent-chat-assets/img-${imgN}.png" alt="附图"/></div>`
        } catch (e) {
          log(`recent-chat 拷图失败：${e?.message ?? e}`)
        }
      }
    }
    blocks.push(
      `<article class="msg ${cls}">`
      + `<header><b>${escapeHtml(role)}</b>`
      + (when ? `<time>${escapeHtml(when)}</time>` : '')
      + `</header>`
      + `<pre>${escapeHtml(displayContent(m.content))}</pre>`
      + imgHtml
      + `</article>`,
    )
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
          `<p class="quick"><a href="./recent-chat-assets/${name}" target="_blank">${escapeHtml(label)}</a></p>`,
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
  :root { color-scheme: light; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  body { margin: 0; background: #f4f6f8; color: #1a1a1a; }
  header.bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
    padding: 12px 16px; z-index: 1; }
  header.bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header.bar p { margin: 4px 0 0; font-size: 12px; color: #6b7280; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .quick a { color: #1d4ed8; }
  .msg { background: #fff; border-radius: 12px; padding: 10px 12px; border: 1px solid #e5e7eb; }
  .msg.user { border-left: 3px solid #93c5fd; }
  .msg.assistant { border-left: 3px solid #86efac; }
  .msg header { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: #6b7280; margin-bottom: 6px; }
  .msg pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; line-height: 1.45; }
  .img { margin-top: 8px; }
  .img img { max-width: 100%; border-radius: 8px; border: 1px solid #e5e7eb; }
</style>
</head>
<body>
<header class="bar">
  <h1>小蓝鲸 · 最近 ${rounds} 轮</h1>
  <p>桌面双击「对话」只是输入框；完整记录在这里。共 ${slice.length} 条消息。</p>
</header>
<main>
${shortcuts.join('\n')}
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
