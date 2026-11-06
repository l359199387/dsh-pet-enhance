/**
 * 失败必须留痕。
 *
 * 只打 `logger.error` 的话，用户看到的现象是「插件不见了」，而原因只在
 * 开发者工具里——模型和人都只能靠猜。所以统一写到 `~/.dsh/glance-error.log`，
 * 文件超过 64KB 就截掉前半，避免无限增长。
 *
 * 注意这里**只记录、不吞异常**：调用方仍然要让失败继续向上抛。
 *
 * @module src/log.js
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 用户能看到的那份日志；和插件自己的数据目录分开，卸载插件也不删它。 */
export function errorLogPath() {
  return join(homedir(), '.dsh', 'glance-error.log')
}

const MAX_BYTES = 64 * 1024

export function writeError(error, scope = 'plugin') {
  try {
    const path = errorLogPath()
    mkdirSync(dirname(path), { recursive: true })

    let size = 0
    try { size = statSync(path).size } catch { /* 第一次写 */ }
    if (size > MAX_BYTES) {
      const old = readFileSync(path, 'utf8')
      writeFileSync(path, old.slice(-MAX_BYTES / 2), 'utf8')
    }

    const text = error?.stack ?? String(error)
    appendFileSync(path, `${new Date().toISOString()} [${scope}] ${text}\n`, 'utf8')
  } catch {
    // 连日志都写不下去时，宁可静默：这里再抛会让真正的失败原因此外被掩盖
  }
}
