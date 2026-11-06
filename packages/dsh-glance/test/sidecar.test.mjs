/**
 * sidecar 进程管理：握手、请求、停干净。真起 Python（Windows + 本机运行时）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSidecarManager, resolvePython, SIDECAR_SCRIPT } from '../src/sidecar.js'

const python = resolvePython()
const canRun = process.platform === 'win32'
  && Boolean(python)
  && (python.includes('\\') || python.includes('/') ? existsSync(python) : true)
  && existsSync(SIDECAR_SCRIPT)

test('resolvePython 能指出一条候选', () => {
  const p = resolvePython()
  assert.ok(p)
  const fallback = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  if (existsSync(fallback)) assert.equal(p, process.env.DSH_GLANCE_PYTHON || process.env.DSH_PYTHON || fallback)
})

test('握手 hello + capture 整屏 + stop 不留进程', { skip: !canRun, timeout: 60_000 }, async () => {
  const logs = []
  const manager = createSidecarManager({
    python,
    log: (m) => logs.push(m),
  })

  const hello = await manager.start()
  assert.equal(hello.ok, true)
  assert.equal(hello.engine, 'pillow')
  assert.equal(hello.input, false)
  assert.ok(manager.isAlive())
  const pid = manager.getPid()
  assert.ok(pid)

  const shot = await manager.call('capture', {
    source: { kind: 'screen' },
    max_width: 798,
  })
  assert.equal(shot.ok, true)
  assert.ok(shot.png)
  assert.ok(shot.w <= 798)

  const listed = await manager.call('windows')
  assert.equal(listed.ok, true)
  assert.ok(Array.isArray(listed.windows))
  assert.ok(listed.windows.length >= 1)

  await manager.stop()
  assert.equal(manager.isAlive(), false)
  assert.equal(manager.getPid(), null)

  // 进程应已消失；若仍在，说明 stop 没杀掉。
  try {
    process.kill(pid, 0)
    assert.fail(`sidecar pid ${pid} 仍在`)
  } catch (e) {
    assert.ok(e && (e.code === 'ESRCH' || e.errno === -3 || /ESRCH|no such process/i.test(String(e))))
  }
})

test('退出后自动重建（kill 子进程）', { skip: !canRun, timeout: 60_000 }, async () => {
  const manager = createSidecarManager({ python })
  await manager.start()
  const pid1 = manager.getPid()
  assert.ok(pid1)

  process.kill(pid1)

  // 退避从 1s 起，给够时间握手。
  let alive = false
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 200))
    if (manager.isAlive() && manager.getPid() && manager.getPid() !== pid1) {
      alive = true
      break
    }
  }
  assert.equal(alive, true, 'kill 后应自动重建')
  await manager.stop()
})
