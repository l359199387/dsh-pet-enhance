/**
 * 测试用的 `defineTool` 替身。
 *
 * 真 `defineTool` 在 dsh 安装目录里，插件单测不该去碰它；这里只保留单测需要的行为：
 * 原样返回、方便断言我们传给它的契约。
 */

export function defineTool(spec) {
  return { ...spec, definedBy: 'fixture' }
}
