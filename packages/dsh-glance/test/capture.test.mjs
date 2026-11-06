/**
 * A1 的实物证明：真的起一次 PowerShell，真的抓一张屏，拿回来的必须是能读的 PNG。
 *
 * 这条测试只能在 Windows 上跑，而且会碰到用户的真实桌面——所以它只抓一整张、
 * 不落盘（内存里读进 Buffer 后临时文件就删了），也不做任何输入。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureScreen, canvasWidth, normalizeQuality } from '../src/capture.js'

const isWindows = process.platform === 'win32'

test('档位只认三档，其它一律回 low', () => {
  assert.equal(normalizeQuality('high'), 'high')
  assert.equal(normalizeQuality(' Standard '), 'standard')
  assert.equal(normalizeQuality('ultra'), 'low')
  assert.equal(normalizeQuality(undefined), 'low')
  assert.equal(canvasWidth('high'), 1260)
  assert.equal(canvasWidth('nope'), 798)
})

test('抓一帧整屏，拿到可读 PNG', { skip: !isWindows, timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'glance-capture-'))
  try {
    const shot = await captureScreen({ quality: 'low', home })

    assert.ok(Buffer.isBuffer(shot.png), 'png 必须是 Buffer')
    assert.equal(shot.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic')
    assert.ok(shot.width > 0 && shot.height > 0)
    assert.ok(shot.width <= 798, 'low 档宽度不超过 798')
    assert.equal(shot.quality, 'low')
    assert.equal(shot.screen.dpiAware, true, '不开 DPI 感知坐标会错')
    assert.ok(Array.isArray(shot.monitors) && shot.monitors.length >= 1)
    assert.ok(shot.ms >= 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
