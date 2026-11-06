import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  appendEpisode,
  buildGlanceEpisode,
  episodeFilePath,
  shouldSkipEpisode,
} from '../src/episode.js'

const home = mkdtempSync(join(tmpdir(), 'glance-ep-'))
after(() => { rmSync(home, { recursive: true, force: true }) })

test('shouldSkipEpisode：敏感窗口标题跳过', () => {
  assert.equal(shouldSkipEpisode('1Password'), true)
  assert.equal(shouldSkipEpisode('记事本'), false)
  assert.equal(shouldSkipEpisode(''), false)
})

test('buildGlanceEpisode：不含截图字节', () => {
  const ep = buildGlanceEpisode({
    userText: '看一眼我的桌面',
    shot: {
      width: 798,
      height: 449,
      quality: 'low',
      engine: 'test',
      ms: 12,
      window: { title: '记事本' },
      png: Buffer.from('secret'),
    },
    result: 'ok',
    durMs: 100,
    reply: '桌上有记事本',
  })
  assert.equal(ep.kind, 'glance')
  assert.match(ep.signature, /win:记事本/)
  assert.equal(ep.meta.replyChars, '桌上有记事本'.length)
  assert.equal(JSON.stringify(ep).includes('secret'), false)
})

test('appendEpisode：按月 JSONL 追加；敏感窗跳过', async () => {
  const ok = await appendEpisode(home, buildGlanceEpisode({
    userText: '看一眼',
    shot: { width: 1, height: 1, quality: 'low', engine: 't', ms: 1 },
    result: 'ok',
    durMs: 5,
  }))
  assert.equal(ok.ok, true)
  const path = episodeFilePath(home)
  const line = readFileSync(path, 'utf8').trim()
  assert.ok(line.startsWith('{'))

  const skip = await appendEpisode(home, buildGlanceEpisode({
    userText: '看一眼',
    shot: { window: { title: 'Bitwarden' }, width: 1, height: 1, quality: 'low' },
    result: 'ok',
    durMs: 1,
  }))
  assert.equal(skip.skipped, true)
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1)
})
