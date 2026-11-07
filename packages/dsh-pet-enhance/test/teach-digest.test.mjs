import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTeachDigestImages,
  chunkFramesForSheets,
  DIGEST_BUDGET,
  dedupeDigestItems,
  describeDigestImagesForPrompt,
  digestEvidenceCount,
  sampleFramesForDigest,
} from '../src/teach-digest.js'

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

test('sampleFramesForDigest：点击过多才均匀抽，保首尾', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ role: 'click', i, file: `${i}.png` }))
  const picked = sampleFramesForDigest(list)
  assert.equal(picked[0].i, 0)
  assert.equal(picked.at(-1).i, 19)
  assert.equal(picked.length, DIGEST_BUDGET.evidenceCap)
  assert.ok(picked.length <= DIGEST_BUDGET.absoluteMax)
})

test('sampleFramesForDigest：点击优先，受 evidenceCap 限制；默认不喂上下文整屏', () => {
  const clicks = Array.from({ length: 10 }, (_, i) => ({ role: 'click', i, kind: 'c' }))
  const ctx = [
    { role: 'key', i: 100, kind: 'k' },
    { role: 'supplement', i: 101, kind: 's' },
    { role: 'key', i: 102, kind: 'k2' },
  ]
  const picked = sampleFramesForDigest([...clicks, ...ctx])
  const clickN = picked.filter((f) => f.role === 'click').length
  const ctxN = picked.filter((f) => f.role === 'key' || f.role === 'supplement').length
  assert.equal(clickN, DIGEST_BUDGET.evidenceCap, '点击受 evidenceCap=4 限制')
  assert.equal(ctxN, 0, '默认 contextCap=0 不喂整屏')
  assert.ok(picked.length <= DIGEST_BUDGET.absoluteMax)
  assert.equal(DIGEST_BUDGET.absoluteMax, 4)
})

test('sampleFramesForDigest：无点击时只少抽上下文', () => {
  const ctx = Array.from({ length: 8 }, (_, i) => ({ role: 'key', i }))
  const picked = sampleFramesForDigest(ctx)
  assert.ok(picked.length <= DIGEST_BUDGET.absoluteMax)
  assert.ok(picked.length <= 4)
})

test('chunkFramesForSheets：按 4 切开', () => {
  const frames = Array.from({ length: 8 }, (_, i) => ({ i }))
  const chunks = chunkFramesForSheets(frames, 4)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length, 4)
  assert.equal(chunks[1].length, 4)
  assert.deepEqual(chunkFramesForSheets(frames.slice(0, 5), 4).map((c) => c.length), [4, 1])
})

test('dedupeDigestItems：字节相同则去重，保留有 click 的', async () => {
  const a = { role: 'key', png: Buffer.from(tinyPng), file: 'a.png' }
  const b = {
    role: 'click',
    png: Buffer.from(tinyPng),
    file: 'b.png',
    click: { eventI: 1, imageX: 10, imageY: 20 },
  }
  const out = await dedupeDigestItems([a, b])
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'click')
})

test('buildTeachDigestImages：4 帧 → 1 张 2×2', async () => {
  const frames = [
    { role: 'click', file: '0.png', click: { eventI: 0, imageX: 1, imageY: 2, imageW: 400, imageH: 400 } },
    { role: 'click', file: '1.png', click: { eventI: 1, imageX: 3, imageY: 4, imageW: 400, imageH: 400 } },
    { role: 'click', file: '2.png', click: { eventI: 2, imageX: 5, imageY: 6, imageW: 400, imageH: 400 } },
    { role: 'click', file: '3.png', click: { eventI: 3, imageX: 7, imageY: 8, imageW: 400, imageH: 400 } },
  ]
  const pngs = frames.map((_, i) => Buffer.concat([tinyPng, Buffer.from([i])]))
  const sidecar = {
    async call(op, body) {
      if (op === 'diff') return { ok: true, score: 50 }
      if (op === 'mosaic') {
        assert.equal(body.frames.length, 4)
        return {
          ok: true,
          png: tinyPng.toString('base64'),
          w: 798,
          h: 462,
          cols: 2,
          rows: 2,
        }
      }
      return { ok: false }
    },
  }
  let i = 0
  const imgs = await buildTeachDigestImages(frames, {
    sidecar,
    async readPng() {
      return pngs[i++]
    },
  })
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].mosaic, true)
  assert.equal(imgs[0].sourceCount, 4)
  assert.equal(digestEvidenceCount(imgs), 4)

  const legend = describeDigestImagesForPrompt(imgs)
  assert.match(legend, /1 张拼图/)
  assert.match(legend, /格1/)
  assert.match(legend, /本格内/)
  assert.match(legend, /勿用拼图全局坐标/)
})

test('buildTeachDigestImages：8 帧 → 1 张 2×2（absoluteMax=4，均匀抽）', async () => {
  const frames = Array.from({ length: 8 }, (_, i) => ({
    role: 'click',
    file: `${i}.png`,
    click: { eventI: i, imageX: i, imageY: i, imageW: 400, imageH: 400 },
  }))
  const pngs = frames.map((_, i) => Buffer.concat([tinyPng, Buffer.from([i])]))
  let mosaicCalls = 0
  const sidecar = {
    async call(op, body) {
      if (op === 'diff') return { ok: true, score: 50 }
      if (op === 'mosaic') {
        mosaicCalls += 1
        assert.ok(body.frames.length <= 4)
        return {
          ok: true,
          png: tinyPng.toString('base64'),
          w: 798,
          h: 462,
          cols: 2,
          rows: 2,
        }
      }
      return { ok: false }
    },
  }
  let i = 0
  const imgs = await buildTeachDigestImages(frames, {
    sidecar,
    async readPng() {
      return pngs[i++]
    },
  })
  assert.equal(mosaicCalls, 1)
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].sheetIndex, 1)
  assert.equal(imgs[0].sheetTotal, 1)
  assert.equal(digestEvidenceCount(imgs), 4)
  assert.equal(imgs[0].cells.length, 4)
  assert.equal(imgs[0].cells[0].index, 1)

  const legend = describeDigestImagesForPrompt(imgs)
  assert.match(legend, /1 张拼图/)
  assert.match(legend, /格1/)
})

test('无 sidecar 时退回多图', async () => {
  const frames = [
    { role: 'click', file: '0.png', click: { eventI: 0, imageX: 1, imageY: 2 } },
    { role: 'click', file: '1.png', click: { eventI: 1, imageX: 3, imageY: 4 } },
  ]
  const imgs = await buildTeachDigestImages(frames, {
    async readPng() {
      return Buffer.from(tinyPng)
    },
  })
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].mosaic, undefined)
})
