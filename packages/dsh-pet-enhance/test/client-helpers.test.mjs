/**
 * client.js 依赖 window.__ModuleLoader__；这里只测导出到 __test 的纯函数。
 * 用 vm 模拟最小 loader，避免在 Node 里真挂 DOM。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')

function loadClientTestApi(opts = {}) {
  const source = readFileSync(CLIENT, 'utf8')
  let api
  const keys = opts.keys || null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          const require = createRequire(CLIENT)
          // client 只 require('react')；测试里给一个空壳。
          const fakeRequire = (id) => {
            if (id === 'react') {
              return {
                createElement() { return null },
                useCallback: (fn) => fn,
                useEffect() {},
                useRef: (v) => ({ current: v }),
                useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
              }
            }
            return require(id)
          }
          api = factory(fakeRequire)
        },
      },
      setTimeout: (fn) => fn(),
    },
    document: {
      dispatchEvent(ev) {
        if (keys) {
          keys.push({
            key: ev.key,
            code: ev.code,
            ctrlKey: Boolean(ev.ctrlKey),
            metaKey: Boolean(ev.metaKey),
            shiftKey: Boolean(ev.shiftKey),
          })
        }
        return true
      },
    },
    navigator: { platform: 'Win32', userAgent: 'test' },
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: CLIENT })
  return api.__test
}

test('client 纯函数：clampPos / stateLabel', () => {
  const api = loadClientTestApi()
  assert.equal(api.stateLabel('alarmed'), '急停')
  assert.equal(api.PET_SIZE, 128)

  // jsdom 没有，给一个假 inner*
  const prev = globalThis.window
  globalThis.window = { innerWidth: 800, innerHeight: 600 }
  try {
    // clampPos 闭包读的是 factory 里的 window——那是 sandbox.window。
    // 这里只断言 API 形状；位置逻辑在浏览器里验。
    assert.equal(typeof api.clampPos, 'function')
    assert.equal(typeof api.defaultPos, 'function')
    assert.equal(api.STORAGE_POS, 'dsh-pet-enhance.pos')
    assert.equal(typeof api.eventOnDshPet, 'function')
    assert.equal(typeof api.bindDshPetClickToChat, 'function')
    assert.equal(typeof api.openDshPetNativeChat, 'function')
  } finally {
    if (prev === undefined) delete globalThis.window
    else globalThis.window = prev
  }
})

test('eventOnDshPet：识别命中区 class', () => {
  const api = loadClientTestApi()
  const hit = { classList: { contains: (c) => c === 'dsh-pet-hit' } }
  assert.equal(api.eventOnDshPet({
    composedPath: () => [hit],
    target: null,
  }), true)
  assert.equal(api.eventOnDshPet({
    composedPath: () => [{ classList: { contains: () => false } }],
    target: { closest: () => null },
  }), false)
})

test('openDshPetNativeChat：hover 发裸 L，global 发主键+Shift+L', () => {
  const keys = []
  const api = loadClientTestApi({ keys })
  api.openDshPetNativeChat('hover')
  assert.equal(keys.length, 1)
  assert.equal(keys[0].key, 'l')
  assert.equal(keys[0].shiftKey, false)
  assert.equal(keys[0].ctrlKey, false)
  keys.length = 0
  api.openDshPetNativeChat('global')
  assert.equal(keys.length, 1)
  assert.equal(keys[0].key, 'l')
  assert.equal(keys[0].shiftKey, true)
  assert.equal(keys[0].ctrlKey || keys[0].metaKey, true)
})
