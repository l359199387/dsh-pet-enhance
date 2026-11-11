/**
 * 轻量中英文案。默认 zh；settings.locale / 环境变量可改。
 *
 * @module src/i18n.js
 */

export const DEFAULT_LOCALE = 'zh'
export const SUPPORTED_LOCALES = Object.freeze(['zh', 'en'])

const ZH = Object.freeze({
  'menu.liveOn': '实时看屏幕 · 开',
  'menu.liveOff': '实时看屏幕 · 关',
  'menu.stop': '小蓝鲸急停',
  'menu.recentChat': '最近聊天内容',
  'menu.confirmYes': '确认动作 · 好',
  'menu.confirmNo': '确认动作 · 不要',

  'bubble.liveOn': '好，开始盯屏幕；有变化会冒泡告诉你。',
  'bubble.liveOff': '好，不盯了；需要时再说「看一眼」（走电脑操控）。',
  'bubble.greet': '小蓝鲸已接入：可以闲聊；看屏/干活走电脑操控；带教与技能看记忆系统。',
  'bubble.chatOff': '这句我当闲聊了。要干活直接说目标；看屏说「看一眼」；带教说「我教你」。',
  'bubble.confirmAsk': '需要你确认：{summary}。请点我头顶「好 / 不要」，或右键「更多」里选。',
  'bubble.taskTakeover': '这事我来办——主会话用电脑操控（windows_computer_use_*）…',
  'bubble.recentChatOpened': '已在浏览器打开最近聊天（含附图）。',
  'bubble.recentChatEmpty': '还没有聊天记录。',
  'bubble.recentChatFail': '打开最近聊天失败：{error}',
})

const EN = Object.freeze({
  'menu.liveOn': 'Live watch · On',
  'menu.liveOff': 'Live watch · Off',
  'menu.stop': 'Blue Whale · Stop',
  'menu.recentChat': 'Recent chat',
  'menu.confirmYes': 'Confirm · OK',
  'menu.confirmNo': 'Confirm · No',

  'bubble.liveOn': 'OK — watching the screen; I’ll bubble when something changes.',
  'bubble.liveOff': 'OK — not watching. Say “look at my screen” (computer-use).',
  'bubble.greet': 'Blue Whale online: casual chat on; screen/tasks via computer-use; teach/skills in Mnemon.',
  'bubble.chatOff': 'Treating that as chat. For work, say the goal; glance; or “teach me”.',
  'bubble.confirmAsk': 'Need your OK: {summary}. Tap 「好 / 不要」above my head, or More menu.',
  'bubble.taskTakeover': 'I’ll handle this — main session windows_computer_use_* …',
  'bubble.recentChatOpened': 'Opened recent chat in your browser (with images).',
  'bubble.recentChatEmpty': 'No chat history yet.',
  'bubble.recentChatFail': 'Could not open recent chat: {error}',
})

const TABLES = Object.freeze({ zh: ZH, en: EN })

export function normalizeLocale(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return DEFAULT_LOCALE
  if (s === 'zh' || s.startsWith('zh-') || s === 'cn' || s === 'chinese') return 'zh'
  if (s === 'en' || s.startsWith('en-') || s === 'english') return 'en'
  return DEFAULT_LOCALE
}

/**
 * @param {string} [locale]
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 */
export function t(locale, key, vars = {}) {
  const loc = normalizeLocale(locale)
  const table = TABLES[loc] || ZH
  let out = table[key] ?? ZH[key] ?? String(key)
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v))
  }
  return out
}

/** 某菜单动作在所有语言下的文案（事件轮询要两边都认）。 */
export function menuLabelVariants(key) {
  return SUPPORTED_LOCALES.map((loc) => t(loc, key)).filter(Boolean)
}

export function menuLabelsFor(locale, { liveWatch = false, pendingConfirm = false } = {}) {
  const labels = [
    t(locale, liveWatch ? 'menu.liveOn' : 'menu.liveOff'),
    t(locale, 'menu.recentChat'),
    t(locale, 'menu.stop'),
  ]
  if (pendingConfirm) {
    labels.push(t(locale, 'menu.confirmYes'), t(locale, 'menu.confirmNo'))
  }
  return labels
}

/** 客户端也可复用同一份表（避免再维护一份）。 */
export function localeTables() {
  return { zh: { ...ZH }, en: { ...EN } }
}
