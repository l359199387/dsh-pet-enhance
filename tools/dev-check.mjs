#!/usr/bin/env node
/**
 * 一键静态门（docs/10 §2 第③步）。
 *
 * 只做「不启动 DSH 就能证明」的检查：
 *   1. 包骨架文件齐全
 *   2. JSON / patch 清单能解析且互相一致
 *   3. 所有 .js / .mjs 能过 `node --check`
 *   4. sidecar 的 .py 能过编译（有 python 才查）
 *   5. src 里没有 console.log（硬约束：日志走统一 log()）
 *   6. 没有 import dsh 自带的 `@deepseek-ai/*`（Host-only bundle 解析不到）
 *
 * 退出码即结论；任何一项红都直接非零。
 *
 * 用法：
 *   node tools/dev-check.mjs
 *   node tools/dev-check.mjs --quiet
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'packages', 'dsh-glance')
const QUIET = process.argv.includes('--quiet')

const PYTHON = process.env.DSH_PYTHON
  || 'C:\\Users\\13591\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'

const results = []

function ok(name, detail) { results.push({ ok: true, name, detail }) }
function bad(name, detail) { results.push({ ok: false, name, detail }) }

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

function checkFiles() {
  const required = ['package.json', 'dsh.plugin.json', 'cordis.patch.yml', 'src/index.js']
  const missing = required.filter((f) => !existsSync(join(PKG, f)))
  if (missing.length) bad('骨架文件', `缺 ${missing.join('、')}`)
  else ok('骨架文件', required.length + ' 个都在')
}

function checkManifests() {
  let pkg
  let plugin
  try {
    pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  } catch (e) {
    bad('package.json', e.message)
    return
  }
  try {
    plugin = JSON.parse(readFileSync(join(PKG, 'dsh.plugin.json'), 'utf8'))
  } catch (e) {
    bad('dsh.plugin.json', e.message)
    return
  }

  if (pkg.type !== 'module') bad('package.json', 'type 必须是 module')
  if (pkg.main !== './src/index.js') bad('package.json', 'main 必须是 ./src/index.js')

  const patch = pkg?.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !existsSync(join(PKG, patch))) {
    bad('package.json', 'dsh.bundle.patch 指向的文件不存在')
  }

  if (plugin.name !== pkg.name) bad('清单一致', `plugin.name(${plugin.name}) ≠ package.name(${pkg.name})`)
  else if (plugin.entry?.name !== pkg.name) bad('清单一致', 'entry.name 必须等于包名')
  else ok('清单一致', pkg.name)

  if (typeof patch === 'string') {
    const text = existsSync(join(PKG, patch)) ? readFileSync(join(PKG, patch), 'utf8') : ''
    if (!text.includes(`id: ${pkg.name}`)) bad(patch, '里面没有插入本插件的那一条')
  }
}

function checkSyntax() {
  const files = walk(PKG).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const failed = []
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (r.status !== 0) failed.push(`${relative(ROOT, file)}: ${(r.stderr || '').trim().split('\n')[0]}`)
  }
  if (failed.length) bad('node --check', failed.join(' | '))
  else ok('node --check', `${files.length} 个文件`)
}

function checkPython() {
  const files = walk(join(PKG, 'sidecar')).filter((f) => f.endsWith('.py'))
  if (!files.length) return ok('python 编译', '还没有 sidecar（A1 起）')
  if (!existsSync(PYTHON)) return ok('python 编译', '找不到 python，跳过')
  const failed = []
  for (const file of files) {
    const r = spawnSync(PYTHON, ['-c', 'import py_compile,sys;py_compile.compile(sys.argv[1], doraise=True)', file], { encoding: 'utf8' })
    if (r.status !== 0) failed.push(`${relative(ROOT, file)}: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`)
  }
  if (failed.length) bad('python 编译', failed.join(' | '))
  else ok('python 编译', `${files.length} 个文件`)
}

function checkConsoleLog() {
  const files = walk(join(PKG, 'src')).filter((f) => f.endsWith('.js'))
  const hits = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/console\.log\s*\(/.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}`)
    })
  }
  if (hits.length) bad('console.log', hits.join('、'))
  else ok('console.log', '干净')
}

function checkHostImports() {
  // 硬约束：Host-only bundle 不 import dsh 自带的包。这些包只在 dsh 自己的解析树里，
  // 从插件目录 import 会拿到 `Cannot find package '@deepseek-ai/…'`——A1 第一次安装
  // 就是这么挂的，而且失败发生在运行时，静态门必须提前拦住。
  const files = walk(PKG).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const hits = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/from\s+['"]@deepseek-ai\//.test(line) || /import\(\s*['"]@deepseek-ai\//.test(line)) {
        hits.push(`${relative(ROOT, file)}:${i + 1}`)
      }
    })
  }
  if (hits.length) bad('宿主包 import', `不能 import @deepseek-ai/*：${hits.join('、')}`)
  else ok('宿主包 import', '没有依赖宿主内部包')
}

function checkTests() {
  const dir = join(PKG, 'test')
  const files = walk(dir).filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.js'))
  if (!files.length) return ok('node --test', '还没有测试（A1 起）')
  // 传目录会被 node 当成模块入口，必须逐个文件传。
  const r = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8' })
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-6).join(' / ')
    bad('node --test', tail || '退出码非零')
    return
  }
  const pass = /(?:^|\s)(?:#|ℹ) pass (\d+)/m.exec(r.stdout ?? '')
  const fail = /(?:^|\s)(?:#|ℹ) fail (\d+)/m.exec(r.stdout ?? '')
  ok('node --test', `${pass ? pass[1] : '?'} 通过 / ${fail ? fail[1] : '0'} 失败`)
}

function main() {
  if (!existsSync(PKG)) {
    console.error(`找不到 ${PKG}`)
    process.exit(2)
  }

  checkFiles()
  checkManifests()
  checkSyntax()
  checkPython()
  checkTests()
  checkConsoleLog()
  checkHostImports()

  const width = Math.max(...results.map((r) => r.name.length))
  for (const r of results) {
    if (QUIET && r.ok) continue
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.log(`\n${failed.length} 项未通过`)
    process.exit(1)
  }
  console.log(`\n全绿（${results.length} 项）`)
}

main()
