import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTeachDigestImages,
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

test('sampleFramesForDigest 保首尾', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ role: 'click', i, file: `${i}.png` }))
  const picked = sampleFramesForDigest(list, 8)
  assert.equal(picked[0].i, 0)
  assert.equal(picked.at(-1).i, 19)
  assert.ok(picked.length <= 8)
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

test('buildTeachDigestImages：有 mosaic sidecar → 1 张拼图', async () => {
  const frames = [
    { role: 'click', file: '0.png', click: { eventI: 0, imageX: 1, imageY: 2, imageW: 400, imageH: 400 } },
    { role: 'click', file: '1.png', click: { eventI: 1, imageX: 3, imageY: 4, imageW: 400, imageH: 400 } },
    { role: 'click', file: '2.png', click: { eventI: 2, imageX: 5, imageY: 6, imageW: 400, imageH: 400 } },
    { role: 'click', file: '3.png', click: { eventI: 3, imageX: 7, imageY: 8, imageW: 400, imageH: 400 } },
  ]
  // 不同 buffer，避免去重掉
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
  // 两张相同 png 会被去重成 1
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].mosaic, undefined)
})
