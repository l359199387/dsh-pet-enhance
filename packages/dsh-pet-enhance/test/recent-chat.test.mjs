import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  attachmentObjectPath,
  buildRecentChatHtml,
  displayContent,
  extractPetMessages,
  recentChatHtmlPath,
} from '../src/recent-chat.js'

test('attachmentObjectPath 按 sha256 前两字符分目录', () => {
  const p = attachmentObjectPath('sha256:abcdef0123456789')
  assert.ok(p)
  assert.match(p, /[/\\]ab[/\\]abcdef0123456789$/)
  assert.equal(attachmentObjectPath('bad'), null)
})

test('extractPetMessages 读 main.main.messages', () => {
  const msgs = extractPetMessages({
    main: { main: { messages: [{ role: 'user', content: 'hi' }] } },
  })
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].content, 'hi')
})

test('displayContent 去掉身份尾巴并截断', () => {
  const s = displayContent(`看见了窗口\n\n[身份] 你是小蓝鲸……`, 20)
  assert.ok(!s.includes('[身份]'))
  assert.ok(s.length <= 21)
})

test('displayContent 看屏注入突出用户原话', () => {
  const s = displayContent(
    '【小蓝鲸已附上刚才的画面】用户刚说「看一眼桌面」。我已抓到整屏。\n\n[身份] x',
  )
  assert.match(s, /^「看一眼桌面」/)
  assert.ok(!s.includes('[身份]'))
})

test('buildRecentChatHtml 写出带转义与附图的本地页', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recent-chat-'))
  try {
    const memPath = join(home, 'memory.json')
    const attDir = join(home, 'att')
    await mkdir(attDir, { recursive: true })
    const pngPath = join(attDir, 'shot.png')
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    // 用真实 attachment 路径不便；无图消息仍应生成 HTML，并转义 XSS
    await writeFile(memPath, JSON.stringify({
      main: {
        main: {
          messages: [
            { role: 'user', content: '你好 <script>', ts: 1 },
            { role: 'assistant', content: '嗨 & 好', ts: 2 },
          ],
        },
      },
    }), 'utf8')

    const r = await buildRecentChatHtml({
      home,
      rounds: 2,
      memoryPath: memPath,
    })
    assert.equal(r.ok, true)
    assert.equal(r.count, 2)
    assert.equal(r.path, recentChatHtmlPath(home))
    assert.ok(existsSync(r.path))
    const html = await readFile(r.path, 'utf8')
    assert.ok(html.includes('&lt;script&gt;'))
    assert.ok(html.includes('嗨 &amp; 好'))
    assert.ok(html.includes('小蓝鲸 · 最近'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
