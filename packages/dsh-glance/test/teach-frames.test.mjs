import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFrameRecorder,
  MAX_KEY_FRAMES,
  learnedFramesDir,
} from '../src/teach-frames.js'

const home = mkdtempSync(join(tmpdir(), 'glance-frames-'))
after(() => rmSync(home, { recursive: true, force: true }))

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

test('关键帧上限 5，补图后可 promote 到 learned/frames', async () => {
  let n = 0
  const rec = createFrameRecorder({
    home,
    sessionId: 'sid-f',
    log() {},
    capture: async () => {
      n += 1
      return { png: tinyPng, window: { title: `W${n}` } }
    },
  })
  await rec.snapStart()
  for (let i = 0; i < 8; i += 1) await rec.maybeOnWindow(`Win-${i}`)
  await rec.snapEnd()
  assert.ok(rec.keyCount() <= MAX_KEY_FRAMES)
  await rec.supplement('before')
  await rec.supplement('after')
  assert.ok(rec.list().length <= MAX_KEY_FRAMES + 2)
  const promoted = await rec.promoteToLearned('sid-f')
  assert.ok(promoted.count >= 1)
  assert.ok(existsSync(join(learnedFramesDir(home, 'sid-f'), 'manifest.json')))
})
