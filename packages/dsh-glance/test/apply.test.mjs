/**
 * 「装得上」的最小证明：不启动 DSH，用假 ctx 跑一遍 apply。
 *
 * 这个测试要盯住的其实是三件事：
 *   1. apply 不抛（抛了宿主那边整行静默消失，用户只看到「没有这个插件」）
 *   2. 路由真的注册到了 `/api/glance`
 *   3. 未受信任的请求被拒，正常请求拿到 200 + JSON
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply, ROUTE_PREFIX } from '../src/index.js'

let home
let registered

before(() => {
  home = mkdtempSync(join(tmpdir(), 'glance-test-'))
  process.env.DSH_GLANCE_HOME = home
})

after(() => {
  delete process.env.DSH_GLANCE_HOME
  rmSync(home, { recursive: true, force: true })
})

/** 足够 apply 跑起来的最小宿主。 */
function fakeCtx() {
  const disposers = []
  return {
    logger: { info() {}, error() {} },
    inject(_services, cb) {
      cb({
        effect(fn) { disposers.push(fn()) },
        get() { return undefined },
        webServer: {
          register(options) {
            registered = options
            return () => { registered = undefined }
          },
        },
      })
    },
    _disposers: disposers,
  }
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.body = text },
  }
}

async function call(url, headers = { host: '127.0.0.1:50521' }) {
  const res = fakeRes()
  await registered.handler({ url, method: 'GET', headers }, res)
  return res
}

test('apply 注册前缀路由，并且能正常返回 status', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)

  assert.equal(typeof dispose, 'function', 'apply 必须返回 disposer')
  assert.equal(registered?.kind, 'prefix')
  assert.equal(registered?.path, ROUTE_PREFIX)

  const res = await call(`${ROUTE_PREFIX}/status`)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.stage, 'A0')
  assert.equal(body.home, home)

  dispose()
  // 路由的清理由宿主销毁 scoped fiber 时触发（`scoped.effect` 的语义），
  // 这里手动跑一遍收集到的清理函数，模拟卸载。
  for (const off of ctx._disposers) off()
  assert.equal(registered, undefined, 'fiber 销毁后路由要摘掉')
})

test('不受信任的请求在进入业务逻辑之前就被拒', async () => {
  const dispose = await apply(fakeCtx())

  const res = await call(`${ROUTE_PREFIX}/status`, { host: 'evil.example' })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).ok, false)

  dispose()
})
