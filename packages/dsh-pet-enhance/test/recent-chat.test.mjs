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
  shouldShowTimeChip,
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

test('displayContent 看屏注入只留用户原话', () => {
  const s = displayContent(
    '【小蓝鲸已附上刚才的画面】用户刚说「看一眼桌面」。我已抓到整屏。\n\n[身份] x',
  )
  assert.equal(s, '看一眼桌面')
})

test('shouldShowTimeChip 间隔约 5 分钟', () => {
  assert.equal(shouldShowTimeChip(0, 1000), true)
  assert.equal(shouldShowTimeChip(1000, 1000 + 4 * 60 * 1000), false)
  assert.equal(shouldShowTimeChip(1000, 1000 + 5 * 60 * 1000), true)
})

test('buildRecentChatHtml 写出微信式气泡与头像', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recent-chat-'))
  try {
    const memPath = join(home, 'memory.json')
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
    assert.ok(html.includes('class="row me"'))
    assert.ok(html.includes('class="row pet"'))
    assert.ok(html.includes('class="bubble"'))
    assert.ok(html.includes('avatar-me.svg'))
    assert.ok(existsSync(join(home, 'cache', 'recent-chat-assets', 'avatar-me.svg')))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
