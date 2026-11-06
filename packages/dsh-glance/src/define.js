/**
 * 拿宿主的 `defineTool`。
 *
 * 插件自己不能重新实现它：`defineTool` 会校验并规范化参数 DSL、包住 `execute`、
 * 给工具打上注册表认的标记。手写一个「长得像」的对象，轻则 schema 校验对不上，
 * 重则整条工具挂不上。
 *
 * dsh 自带的包从 dsh 安装目录解析（不是 profile 的 node_modules），所以正常装上
 * 就能 import 到。`DSH_TOOLS_PATH` 只是本地起一个没有 dsh 安装时的逃生口。
 *
 * @module src/define.js
 */

import { pathToFileURL } from 'node:url'

let cached

export async function loadDefineTool() {
  if (cached) return cached

  const failures = []

  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod?.defineTool === 'function') {
      cached = mod.defineTool
      return cached
    }
    failures.push('@deepseek-ai/dsh-tools 没有导出 defineTool')
  } catch (e) {
    failures.push(`import @deepseek-ai/dsh-tools 失败：${e?.message ?? e}`)
  }

  const override = process.env.DSH_TOOLS_PATH
  if (override) {
    try {
      const mod = await import(pathToFileURL(override).href)
      if (typeof mod?.defineTool === 'function') {
        cached = mod.defineTool
        return cached
      }
      failures.push('DSH_TOOLS_PATH 指向的模块没有导出 defineTool')
    } catch (e) {
      failures.push(`import DSH_TOOLS_PATH 失败：${e?.message ?? e}`)
    }
  }

  throw new Error(`拿不到 defineTool（${failures.join('；')}）`)
}
