/**
 * 「装得上、拔得掉」的最小证明：不启动 DSH，用假 ctx 跑一遍 apply。
 *
 * 这个测试要盯住四件事：
 *   1. apply 不抛（抛了宿主那边整行静默消失，用户只看到「没有这个插件」）
 *   2. 路由真的注册到了 `/api/glance`
 *   3. `glance` 工具挂上去了，`/status` 里能看见
 *   4. 卸载后路由和工具都摘干净
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { apply, ROUTE_PREFIX } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

let home
let registered

before(() => {
  home = mkdtempSync(join(tmpdir(), 'glance-test-'))
  process.env.DSH_GLANCE_HOME = home
  // 单测不去碰 dsh 安装目录里的真 defineTool。
  process.env.DSH_TOOLS_PATH = join(HERE, 'fixtures', 'fake-tools.mjs')
})

after(() => {
  delete process.env.DSH_GLANCE_HOME
  delete process.env.DSH_TOOLS_PATH
  rmSync(home, { recursive: true, force: true })
})

/** 让异步注册（import + register）跑完。 */
async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise((done) => setTimeout(done, 0))
}

/** 足够 apply 跑起来的最小宿主。 */
function fakeCtx() {
  const disposers = []
  const tools = []
  return {
    logger: { info() {}, error() {} },
    inject(services, cb) {
      const scoped = {
        effect(fn) { disposers.push(fn()) },
        get() { return undefined },
      }
      if (services.includes('webServer')) {
        scoped.webServer = {
          register(options) {
            registered = options
            return () => { registered = undefined }
          },
        }
      }
      if (services.includes('tools')) {
        scoped.tools = {
          register(tool) {
            tools.push(tool)
            return () => {
              const index = tools.indexOf(tool)
              if (index >= 0) tools.splice(index, 1)
            }
          },
        }
        scoped.attachments = { saveImage: async () => ({ id: 'fake-image' }) }
      }
      cb(scoped)
    },
    _disposers: disposers,
    _tools: tools,
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

test('apply 注册路由与 glance 工具，status 能看到它们', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)
  await flush()

  assert.equal(typeof dispose, 'function', 'apply 必须返回 disposer')
  assert.equal(registered?.kind, 'prefix')
  assert.equal(registered?.path, ROUTE_PREFIX)

  assert.equal(ctx._tools.length, 1, 'glance 应该挂上了')
  assert.equal(ctx._tools[0].name, 'glance')
  assert.equal(ctx._tools[0].definedBy, 'fixture', '必须用宿主给的 defineTool')

  const res = await call(`${ROUTE_PREFIX}/status`)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.stage, 'A1')
  assert.equal(body.home, home)
  assert.deepEqual(body.tools, ['glance'])

  dispose()
  // 路由与工具的清理由宿主销毁 scoped fiber 时触发（`scoped.effect` 的语义），
  // 这里手动跑一遍收集到的清理函数，模拟卸载。
  for (const off of ctx._disposers) off()
  assert.equal(registered, undefined, 'fiber 销毁后路由要摘掉')
  assert.equal(ctx._tools.length, 0, 'fiber 销毁后工具要摘掉')
})

test('不受信任的请求在进入业务逻辑之前就被拒', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)
  await flush()

  const res = await call(`${ROUTE_PREFIX}/status`, { host: 'evil.example' })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).ok, false)

  dispose()
})
