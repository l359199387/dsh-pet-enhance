import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  attachClickFramesToPlaybook,
  clickCropRegion,
  CLICK_CROP_SIZE,
  createFrameRecorder,
  describeClickFramesForPrompt,
  learnedFramesDir,
  mapClickToCropImage,
  mapScreenToImageCoords,
  MAX_DIGEST_IMAGES,
  MAX_KEY_FRAMES,
  resolveVirtualBounds,
  sampleFramesForDigest,
} from '../src/teach-frames.js'

const home = mkdtempSync(join(tmpdir(), 'glance-frames-'))
after(() => rmSync(home, { recursive: true, force: true }))

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

test('sampleFramesForDigest：过多时均匀抽且保首尾', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ role: 'click', i, file: `${i}.png` }))
  const picked = sampleFramesForDigest(list, 8)
  assert.ok(picked.length <= MAX_DIGEST_IMAGES)
  assert.equal(picked[0].i, 0)
  assert.equal(picked[picked.length - 1].i, 19)
})

test('clickCropRegion：居中 400 并贴边', () => {
  const mid = clickCropRegion(800, 450, { x: 0, y: 0, w: 1600, h: 900 }, 400)
  assert.deepEqual(mid, { x: 600, y: 250, w: 400, h: 400 })
  const edge = clickCropRegion(10, 10, { x: 0, y: 0, w: 1600, h: 900 }, 400)
  assert.equal(edge.x, 0)
  assert.equal(edge.y, 0)
  assert.equal(edge.w, 400)
})

test('mapClickToCropImage：相对裁切区；缩放时按图规格', () => {
  const region = { x: 600, y: 250, w: 400, h: 400 }
  const m = mapClickToCropImage(800, 450, region, { width: 400, height: 400 })
  assert.equal(m.imageX, 200)
  assert.equal(m.imageY, 200)
  assert.equal(m.mapped, true)
  const scaled = mapClickToCropImage(800, 450, region, { width: 200, height: 200 })
  assert.equal(scaled.imageX, 100)
  assert.equal(scaled.imageY, 100)
})

test('mapScreenToImageCoords：整屏缩放仍可用', () => {
  const m = mapScreenToImageCoords(1920, 1080, {
    width: 798,
    height: 449,
    screen: { w: 1920, h: 1080 },
  })
  assert.equal(m.mapped, true)
  assert.equal(m.imageX, 798)
  assert.equal(m.imageY, 449)
})

test('resolveVirtualBounds 读 virtual', () => {
  const b = resolveVirtualBounds({ w: 1920, h: 1080, virtual: { x: -100, y: 0, w: 3000, h: 1080 } })
  assert.deepEqual(b, { x: -100, y: 0, w: 3000, h: 1080 })
})

test('点击帧：400 区域抓取 + 图内近中心坐标', async () => {
  const captures = []
  const rec = createFrameRecorder({
    home,
    sessionId: 'sid-crop',
    log() {},
    sidecar: {
      getHello: () => ({ screen: { w: 1600, h: 900, virtual: { x: 0, y: 0, w: 1600, h: 900 } } }),
    },
    capture: async (opts) => {
      captures.push(opts)
      if (opts.region) {
        return {
          png: tinyPng,
          width: opts.region.w,
          height: opts.region.h,
          screen: { w: 1600, h: 900, virtual: { x: 0, y: 0, w: 1600, h: 900 } },
          window: { title: '桌面' },
        }
      }
      return {
        png: tinyPng,
        width: 798,
        height: 449,
        screen: { w: 1600, h: 900 },
        window: { title: '桌面' },
      }
    },
  })
  await rec.snapStart()
  await rec.snapOnClick({ eventI: 0, x: 800, y: 450, button: 'left', action: 'click' })
  await rec.snapOnClick({ eventI: 1, x: 800, y: 450, button: 'right', action: 'click' })
  await rec.snapOnScrollBoundary({ eventI: 2, x: 800, y: 450, phase: 'start', delta: 1 })
  await rec.snapOnScrollBoundary({ eventI: 3, x: 800, y: 450, phase: 'end', delta: 4 })
  await rec.snapEnd()

  assert.ok(rec.keyCount() <= MAX_KEY_FRAMES)
  assert.equal(rec.clickCount(), 2)
  assert.equal(rec.scrollCount(), 2)
  const clickCap = captures.find((c) => c.region)
  assert.ok(clickCap)
  assert.equal(clickCap.quality, 'standard')
  assert.deepEqual(clickCap.region, { x: 600, y: 250, w: CLICK_CROP_SIZE, h: CLICK_CROP_SIZE })

  const click = rec.list().find((f) => f.role === 'click')
  assert.equal(click.click.imageX, 200)
  assert.equal(click.click.imageY, 200)
  assert.equal(click.click.imageW, 400)
  assert.deepEqual(click.click.crop, { x: 600, y: 250, w: 400, h: 400 })
  assert.equal(click.click.button, 'left')

  const legend = describeClickFramesForPrompt(await rec.loadPngBuffers())
  assert.match(legend, /图内坐标 \(200,200\)/)
  assert.match(legend, /勿用整屏坐标/)
  assert.match(legend, /400×400/)
  assert.match(legend, /滚动开始/)
  assert.match(legend, /滚动结束/)
  assert.match(legend, /中间滚动格不截图/)

  const pb = {
    steps: [
      { i: 0, eventI: 0, mode: 'glance', action: 'click', hint: { x: 800, y: 450 } },
      { i: 2, eventI: 2, mode: 'glance', action: 'scroll', phase: 'start', hint: { x: 800, y: 450 } },
    ],
  }
  attachClickFramesToPlaybook(pb, rec.list())
  assert.equal(pb.steps[0].hint.imageX, 200)
  assert.equal(pb.steps[0].hint.crop.w, 400)
  assert.equal(pb.steps[1].hint.phase, 'start')
  assert.ok(pb.steps[1].hint.frameFile)

  const promoted = await rec.promoteToLearned('sid-crop')
  assert.equal(promoted.clicks, 2)
  assert.equal(promoted.scrolls, 2)
  const manifest = JSON.parse(readFileSync(join(learnedFramesDir(home, 'sid-crop'), 'manifest.json'), 'utf8'))
  assert.equal(manifest.frames.find((f) => f.role === 'click').click.crop.w, 400)
  assert.ok(manifest.frames.some((f) => f.role === 'scroll' && f.scroll?.phase === 'end'))
  assert.ok(existsSync(join(learnedFramesDir(home, 'sid-crop'), 'manifest.json')))
})
