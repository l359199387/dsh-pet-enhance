import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildGlanceMap,
  formatCoordHint,
  mapImageToScreen,
  maybeRemapImageCoordsAsScreen,
} from '../src/coords.js'
import {
  buildGuardedInputActions,
  prependFocusIfNeeded,
  resolveActCoords,
} from '../src/tool-act.js'
import { confirmSignature, evaluateActPolicy, isSubmitFamily } from '../src/policy.js'

test('mapImageToScreen：整屏缩略图换算', () => {
  const map = {
    originX: 0,
    originY: 0,
    captureW: 2560,
    captureH: 1440,
    imageW: 798,
    imageH: 449,
  }
  const p = mapImageToScreen(399, 224, map)
  assert.equal(p.mapped, true)
  assert.ok(Math.abs(p.x - 1280) <= 2)
  assert.ok(Math.abs(p.y - 720) <= 2)
})

test('buildGlanceMap：用 rect', () => {
  const map = buildGlanceMap({
    width: 400,
    height: 300,
    rect: [100, 200, 500, 500],
    quality: 'high',
  })
  assert.equal(map.originX, 100)
  assert.equal(map.originY, 200)
  assert.equal(map.captureW, 400)
  assert.equal(map.captureH, 300)
  assert.match(formatCoordHint(map), /坐标换算/)
})

test('maybeRemapImageCoordsAsScreen：缩略图误当屏幕时救回', () => {
  const map = {
    originX: 0,
    originY: 0,
    captureW: 2560,
    captureH: 1440,
    imageW: 798,
    imageH: 449,
  }
  const r = maybeRemapImageCoordsAsScreen(100, 100, map)
  assert.equal(r.remapped, true)
  assert.ok(r.x > 200)
  const keep = maybeRemapImageCoordsAsScreen(1200, 800, map)
  assert.equal(keep.remapped, false)
})

test('resolveActCoords：imageX/Y 优先', () => {
  const map = {
    originX: 10,
    originY: 20,
    captureW: 1000,
    captureH: 500,
    imageW: 500,
    imageH: 250,
  }
  const { args, remapped, fromImage } = resolveActCoords({
    action: 'click',
    imageX: 250,
    imageY: 125,
  }, map)
  assert.equal(remapped, true)
  assert.equal(fromImage, true)
  assert.equal(args.x, 510)
  assert.equal(args.y, 270)
})

test('prependFocusIfNeeded：确认后补 focus，标题取破折号后段', () => {
  const out = prependFocusIfNeeded(
    [{ kind: 'click', x: 1, y: 2 }],
    '小蓝鲸问候 - 豆包',
    true,
  )
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { kind: 'focus', window: '豆包' })
  assert.equal(out[1].kind, 'click')
})

test('buildGuardedInputActions：确认后回车先点回输入框', () => {
  const out = buildGuardedInputActions(
    [{ kind: 'key', keys: 'enter' }],
    {
      windowTitle: '小蓝鲸问候 - 豆包',
      needsRefocus: true,
      confirmed: true,
      keys: 'enter',
      lastInputClick: { x: 780, y: 726, at: Date.now() },
    },
  )
  assert.equal(out[0].kind, 'focus')
  assert.equal(out[1].kind, 'click')
  assert.equal(out[1].x, 780)
  assert.equal(out[2].kind, 'wait')
  assert.equal(out[3].kind, 'key')
})

test('发送族确认签名统一，回车与点发送只确认一次', () => {
  assert.equal(isSubmitFamily({ action: 'key', keys: 'enter', reason: '回车发送' }), true)
  assert.equal(isSubmitFamily({ action: 'click', x: 1, y: 2, reason: '点蓝色发送按钮' }), true)
  const a = confirmSignature({ action: 'key', keys: 'enter', reason: '回车发送' }, 'L2')
  const b = confirmSignature({ action: 'click', x: 1, y: 2, reason: '点发送' }, 'L2')
  assert.equal(a, 'L2|family:submit')
  assert.equal(b, a)

  const remembered = new Set([a])
  const second = evaluateActPolicy({
    args: { action: 'click', x: 10, y: 10, reason: '点蓝色发送箭头' },
    screen: { w: 2560, h: 1440 },
    remembered,
  })
  assert.equal(second.ok, true)
  assert.equal(second.needsConfirm, false)
})
