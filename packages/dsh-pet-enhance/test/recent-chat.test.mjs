import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  attachmentObjectPath,
  buildRecentChatHtml,
  chunkPages,
  displayContent,
  extractPetMessages,
  formatTs,
  isGlanceInject,
  prepareChatRows,
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

test('displayContent / isGlanceInject', () => {
  assert.ok(!displayContent(`看见了\n\n[身份] x`).includes('[身份]'))
  assert.equal(
    displayContent('【小蓝鲸已附上刚才的画面】用户刚说「看一眼桌面」。其余'),
    '看一眼桌面',
  )
  assert.equal(isGlanceInject('【小蓝鲸已附上刚才的画面】用户刚说「x」'), true)
  assert.equal(isGlanceInject('看一眼桌面'), false)
})

test('shouldShowTimeChip / formatTs', () => {
  assert.equal(shouldShowTimeChip(0, 1000), true)
  assert.equal(shouldShowTimeChip(1000, 1000 + 4 * 60 * 1000), false)
  const now = Date.parse('2026-11-07T12:00:00')
  assert.match(formatTs(Date.parse('2026-11-07T10:35:00'), now), /^今天 /)
})

test('prepareChatRows 把注入附图挪到小蓝鲸回复', async () => {
  const rows = await prepareChatRows([
    { role: 'user', content: '看一眼桌面', ts: 1 },
    { role: 'assistant', content: '好，我瞅一眼…', ts: 2 },
    {
      role: 'user',
      content: '【小蓝鲸已附上刚才的画面】用户刚说「看一眼桌面」。说明',
      ts: 3,
    },
    { role: 'assistant', content: '桌面上有窗口', ts: 4 },
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].content, '看一眼桌面')
  assert.equal(rows[2].content, '桌面上有窗口')
  assert.ok(Array.isArray(rows[2].images))
})

test('chunkPages 从早到晚切页', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: String(i), ts: i }))
  const pages = chunkPages(rows, 10)
  assert.equal(pages.length, 3)
  assert.equal(pages[0].length, 10)
  assert.equal(pages[0][0].content, '0')
  assert.equal(pages[2][0].content, '20')
})

test('buildRecentChatHtml 分页数据与上滑提示', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recent-chat-'))
  try {
    const memPath = join(home, 'memory.json')
    const messages = []
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `u${i} <b>`, ts: i * 2 })
      messages.push({ role: 'assistant', content: `a${i} & x`, ts: i * 2 + 1 })
    }
    await writeFile(memPath, JSON.stringify({
      main: { main: { messages } },
    }), 'utf8')

    const r = await buildRecentChatHtml({
      home,
      pageSize: 10,
      memoryPath: memPath,
    })
    assert.equal(r.ok, true)
    assert.ok(r.pages >= 2)
    assert.equal(r.path, recentChatHtmlPath(home))
    const html = await readFile(r.path, 'utf8')
    assert.ok(html.includes('id="chat-data"'))
    assert.ok(html.includes('top-sentinel'))
    assert.ok(html.includes('上滑'))
    assert.ok(html.includes('prependPage'))
    assert.ok(html.includes('createDocumentFragment'))
    assert.ok(html.includes('stickBottomOnOpen') || html.includes('scrollToBottom'))
    assert.ok(html.includes('bottom-anchor'))
    assert.ok(html.includes('id="lightbox"'))
    assert.ok(html.includes('#chat-list'))
    assert.ok(html.includes('gap: 22px'))
    assert.ok(html.includes('.avatar.pet'))
    assert.ok(html.includes('data:image/png;base64') || html.includes('data:image/svg+xml'))
    assert.ok(html.includes('u29') || html.includes('\\u003c'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
