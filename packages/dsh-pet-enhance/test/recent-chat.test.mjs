import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  attachmentObjectPath,
  buildRecentChatHtml,
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
      // 无真实文件 → 无 uri，但仍应跳过这条用户气泡
    },
    { role: 'assistant', content: '桌面上有窗口', ts: 4 },
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].content, '看一眼桌面')
  assert.equal(rows[1].content, '好，我瞅一眼…')
  assert.equal(rows[2].role, 'assistant')
  assert.equal(rows[2].content, '桌面上有窗口')
})

test('buildRecentChatHtml 内嵌头像 data URI 与气泡', async () => {
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

    const r = await buildRecentChatHtml({ home, rounds: 2, memoryPath: memPath })
    assert.equal(r.ok, true)
    assert.equal(r.path, recentChatHtmlPath(home))
    assert.ok(existsSync(r.path))
    const html = await readFile(r.path, 'utf8')
    assert.ok(html.includes('&lt;script&gt;'))
    assert.ok(html.includes('嗨 &amp; 好'))
    assert.ok(html.includes('class="row me"'))
    assert.ok(html.includes('class="row pet"'))
    assert.ok(html.includes('data:image/svg+xml'))
    assert.ok(!html.includes('avatar-pet.svg'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
