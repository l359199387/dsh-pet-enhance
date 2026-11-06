/**
 * L 对话意图粗筛（决定走哪条桥；真正理解交给模型）。
 *
 * @module src/intent.js
 */

/** chat-bridge 附图 follow-up 前缀——不得再命中看屏意图。 */
export const GLANCE_FOLLOWUP_PREFIX = '【小蓝鲸已附上刚才的画面】'

/** agent-bridge 叫醒主会话的前缀。 */
export const AGENT_WAKE_PREFIX = '【小蓝鲸交办】'

export const GLANCE_INTENT_RE =
  /(?:看(?:一?眼|看|下|一下)?|帮我看(?:一?眼|一下)?)(?:我的|下我的)?(?:屏幕|桌面|画面)|(?:屏幕|桌面)上|截(?:个|一)?图|现在(?:的)?(?:桌面|屏幕)|这个窗口|窗口里|(?:看|瞅)一眼|glance/i

/**
 * 粗筛「可能要操作电脑」。只决定要不要叫醒带 glance/act 的 Agent；
 * 点哪里、按什么键由模型看屏后决定。
 */
export const COMPUTER_TASK_RE =
  /(?:帮我|请(?:你)?|麻烦|给我)?[\s\S]{0,40}?(?:点(?:击|一下|开)?|双击|右键|拖(?:拽|到)?|滚(?:动|轮)?|输入|键入|打字|按下?|打开|关闭|关掉|退出|杀掉|最小化|最大化|还原|聚焦|切换到?|选中|勾选|取消|保存|发送|复制|粘贴|剪切|删除|清空|刷新|提交|确认|搜索|改成|设置成|调成|移到|挪到|放到|运行|启动|click|type|minimize|maximize)|(?:把|将|让).{0,40}?(?:最小化|最大化|关掉|关闭|点(?:一下|开)?|输入|改成|移到|打开)/i

function isBridgeEcho(s) {
  return (
    s.startsWith(GLANCE_FOLLOWUP_PREFIX)
    || s.startsWith(AGENT_WAKE_PREFIX)
  )
}

export function isGlanceIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return GLANCE_INTENT_RE.test(s)
}

export function isComputerTaskIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return COMPUTER_TASK_RE.test(s)
}

/** 干活意图优先走 Agent；chat-bridge 应跳过，避免又抓一帧抢话。 */
export function shouldSkipGlanceBridge(text) {
  return isComputerTaskIntent(text)
}
