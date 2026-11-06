import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  attachClickFramesToPlaybook,
  createFrameRecorder,
  describeClickFramesForPrompt,
  learnedFramesDir,
  mapScreenToImageCoords,
  MAX_KEY_FRAMES,
} from '../src/teach-frames.js'

const home = mkdtempSync(join(tmpdir(), 'glance-frames-'))
after(() => rmSync(home, { recursive: true, force: true }))

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

test('mapScreenToImageCoords：按屏幕→图缩放', () => {
  const m = mapScreenToImageCoords(1920, 1080, {
    width: 798,
    height: 449,
    screen: { w: 1920, h: 1080 },
  })
  assert.equal(m.mapped, true)
  assert.equal(m.imageX, 798)
  assert.equal(m.imageY, 449)
})

test('上下文关键帧上限 5；点击帧每次一张且带图内坐标', async () => {
  let n = 0
  const rec = createFrameRecorder({
    home,
    sessionId: 'sid-f',
    log() {},
    capture: async () => {
      n += 1
      return {
        png: tinyPng,
        width: 798,
        height: 449,
        screen: { w: 1600, h: 900 },
        window: { title: `W${n}` },
      }
    },
  })
  await rec.snapStart()
  for (let i = 0; i < 8; i += 1) await rec.maybeOnWindow(`Win-${i}`)
  await rec.snapOnClick({ eventI: 0, x: 800, y: 450, button: 'left', action: 'click' })
  await rec.snapOnClick({ eventI: 1, x: 100, y: 200, button: 'left', action: 'double_click' })
  await rec.snapEnd()
  assert.ok(rec.keyCount() <= MAX_KEY_FRAMES)
  assert.equal(rec.clickCount(), 2)
  const clicks = rec.list().filter((f) => f.role === 'click')
  assert.equal(clicks[0].click.imageX, 399)
  assert.equal(clicks[0].click.imageY, Math.round(450 * 449 / 900))
  assert.equal(clicks[0].click.mapped, true)

  const legend = describeClickFramesForPrompt(await rec.loadPngBuffers())
  assert.match(legend, /图内坐标\(399,\d+\)/)
  assert.match(legend, /步骤#1/)

  const pb = {
    steps: [
      { i: 0, eventI: 0, mode: 'glance', action: 'click', hint: { x: 800, y: 450 } },
      { i: 1, eventI: 1, mode: 'glance', action: 'double_click', hint: { x: 100, y: 200 } },
    ],
  }
  attachClickFramesToPlaybook(pb, rec.list())
  assert.equal(pb.steps[0].hint.imageX, 399)
  assert.equal(pb.steps[0].hint.frameFile, clicks[0].file)

  const promoted = await rec.promoteToLearned('sid-f')
  assert.equal(promoted.clicks, 2)
  const manifest = JSON.parse(readFileSync(join(learnedFramesDir(home, 'sid-f'), 'manifest.json'), 'utf8'))
  assert.ok(manifest.frames.some((f) => f.click?.eventI === 0))
  assert.ok(existsSync(join(learnedFramesDir(home, 'sid-f'), 'manifest.json')))
})
