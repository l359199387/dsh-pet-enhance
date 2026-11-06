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
  'menu.actOn': '允许动手 · 开',
  'menu.actOff': '允许动手 · 关',
  'menu.stop': '小蓝鲸急停',
  'menu.confirmYes': '确认动作 · 好',
  'menu.confirmNo': '确认动作 · 不要',

  'bubble.actOn': '好，允许动手了。我会按你的话点鼠标、打字；甩到左上角或点急停可立刻停。',
  'bubble.actOff': '好，收手了。act 已关闭，不会再动鼠标键盘。',
  'bubble.liveOn': '好，开始盯屏幕；有变化会冒泡告诉你。',
  'bubble.liveOff': '好，不盯了；需要时再说「看一眼」。',
  'bubble.greet': '小蓝鲸已接入：随便聊；想看屏幕、教我操作、或让我动手，直接说就行，我会先判断再行动。',

  'learned.title': '我学会的',
  'learned.sub': '卡片查看学习理解与执行记录；可搜索标题，对执行评价后会改正理解。编辑里的「补充」保存后也会并入理解并清空。',
  'learned.count': '{n} 条',
  'learned.countFiltered': '{shown}/{total} 条',
  'learned.searchPlaceholder': '模糊搜索标题，例如：B站、心情…',
  'learned.loading': '加载中…',
  'learned.empty': '还没有学会的条目。',
  'learned.emptyHint': '打开「实时看屏幕」教一遍，点「我教完了」就会出现在这里。',
  'learned.noMatch': '没有匹配的标题，换个关键词试试。',
  'learned.understanding': '小蓝鲸的学习理解',
  'learned.understandingEmpty': '（教完后会写在这里；点编辑用「补充」帮它完善）',
  'learned.edit': '编辑',
  'learned.delete': '删除',
  'learned.scheduled': '已定时',
  'learned.unscheduled': '不定时',
  'learned.runs': '执行记录（{n}）',
  'learned.runsExpand': '展开',
  'learned.runsCollapse': '收起',
  'learned.runsEmpty': '还没有执行记录。对小蓝鲸说「去看看… / 执行一下…」跑过后会出现在这里。',
  'learned.runOk': '成功',
  'learned.runFail': '失败',
  'learned.rateGood': '好',
  'learned.rateOk': '一般',
  'learned.rateBad': '差',
  'learned.rateCommentPh': '可选：写下哪里不对，例如应直接打开 bilibili.com…',
  'learned.rateSubmit': '提交评价并改正',
  'learned.rateBusy': '改正中…',
  'learned.rated': '已评：{label}',
  'learned.refined': ' · 已改正理解',
  'learned.pickRating': '请先选好 / 一般 / 差',
  'learned.ratingBusy': '正在根据评价改正学习理解…',
  'learned.ratingDone': '已根据评价改正学习理解',
  'learned.ratingSaved': '评价已记',
  'learned.editTitle': '编辑学会条目',
  'learned.editSub': '「补充」只用来帮助小蓝鲸更新学习理解；理解完成后补充会自动清空。',
  'learned.goal': '目标标题',
  'learned.understandingReadonly': '小蓝鲸的学习理解（只读）',
  'learned.understandingNone': '尚无理解，填写补充并保存后会生成/更新。',
  'learned.notes': '补充',
  'learned.notesHint': '写下你的偏好、约束或纠正；保存后会并入上方理解，并清空本栏。',
  'learned.notesPh': '例如：心情笔记写到桌面「每日心情」；语气轻松一点…',
  'learned.cancel': '取消',
  'learned.save': '保存',
  'learned.saving': '归纳中…',
  'learned.saveBusy': '保存中…有补充时会归纳进学习理解',
  'learned.savedMerged': '已保存：补充已并入学习理解，并已清空',
  'learned.saved': '已保存',
  'learned.deleteTitle': '确认删除？',
  'learned.deleteBody': '将删除「{goal}」。',
  'learned.deleteWarn': '本地学习文件、自动化记录会一并清除；若有对应定时任务也会删除。此操作不可撤销。',
  'learned.deleting': '删除中…',
  'learned.confirmDelete': '确认删除',
  'learned.langZh': '中文',
  'learned.langEn': 'EN',
})

const EN = Object.freeze({
  'menu.liveOn': 'Live watch · On',
  'menu.liveOff': 'Live watch · Off',
  'menu.actOn': 'Allow act · On',
  'menu.actOff': 'Allow act · Off',
  'menu.stop': 'Blue Whale · Stop',
  'menu.confirmYes': 'Confirm · OK',
  'menu.confirmNo': 'Confirm · No',

  'bubble.actOn': 'OK — acting is on. I’ll click/type as you ask; fling the cursor to the top-left or hit Stop to abort.',
  'bubble.actOff': 'OK — hands off. act is disabled; I won’t move mouse or keyboard.',
  'bubble.liveOn': 'OK — watching the screen; I’ll bubble when something changes.',
  'bubble.liveOff': 'OK — not watching. Say “look at my screen” when you need a glance.',
  'bubble.greet': 'Blue Whale online: chat anytime; ask to look, teach me, or act — I’ll route first.',

  'learned.title': 'What I learned',
  'learned.sub': 'Cards show understanding and run history. Search titles; rate a run to refine understanding. Edit → Notes merges into understanding then clears.',
  'learned.count': '{n} items',
  'learned.countFiltered': '{shown}/{total} items',
  'learned.searchPlaceholder': 'Fuzzy search titles, e.g. Bilibili, mood…',
  'learned.loading': 'Loading…',
  'learned.empty': 'Nothing learned yet.',
  'learned.emptyHint': 'Turn on Live watch, teach once, tap “I’m done teaching” — it will show up here.',
  'learned.noMatch': 'No matching titles. Try another keyword.',
  'learned.understanding': 'Understanding',
  'learned.understandingEmpty': '(Filled after teaching; Edit → Notes to refine.)',
  'learned.edit': 'Edit',
  'learned.delete': 'Delete',
  'learned.scheduled': 'Scheduled',
  'learned.unscheduled': 'On demand',
  'learned.runs': 'Runs ({n})',
  'learned.runsExpand': 'Expand',
  'learned.runsCollapse': 'Collapse',
  'learned.runsEmpty': 'No runs yet. Tell the pet “go watch…” / “run…” once.',
  'learned.runOk': 'OK',
  'learned.runFail': 'Failed',
  'learned.rateGood': 'Good',
  'learned.rateOk': 'OK',
  'learned.rateBad': 'Bad',
  'learned.rateCommentPh': 'Optional: what went wrong, e.g. open bilibili.com directly…',
  'learned.rateSubmit': 'Submit rating & refine',
  'learned.rateBusy': 'Refining…',
  'learned.rated': 'Rated: {label}',
  'learned.refined': ' · understanding updated',
  'learned.pickRating': 'Pick Good / OK / Bad first',
  'learned.ratingBusy': 'Refining understanding from your rating…',
  'learned.ratingDone': 'Understanding updated from your rating',
  'learned.ratingSaved': 'Rating saved',
  'learned.editTitle': 'Edit learned item',
  'learned.editSub': 'Notes only help update understanding; they clear after a successful merge.',
  'learned.goal': 'Goal title',
  'learned.understandingReadonly': 'Understanding (read-only)',
  'learned.understandingNone': 'No understanding yet — add Notes and save to create/update.',
  'learned.notes': 'Notes',
  'learned.notesHint': 'Preferences or corrections; merged into understanding on save, then cleared.',
  'learned.notesPh': 'e.g. write mood notes to Desktop “Daily mood”; keep tone light…',
  'learned.cancel': 'Cancel',
  'learned.save': 'Save',
  'learned.saving': 'Merging…',
  'learned.saveBusy': 'Saving… Notes will merge into understanding when present',
  'learned.savedMerged': 'Saved: Notes merged into understanding and cleared',
  'learned.saved': 'Saved',
  'learned.deleteTitle': 'Delete this item?',
  'learned.deleteBody': 'Delete “{goal}”.',
  'learned.deleteWarn': 'Local learned files and automation will be removed; any schedule will be deleted. This cannot be undone.',
  'learned.deleting': 'Deleting…',
  'learned.confirmDelete': 'Delete',
  'learned.langZh': '中文',
  'learned.langEn': 'EN',
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

export function menuLabelsFor(locale, { liveWatch = false, actEnabled = false, pendingConfirm = false } = {}) {
  const labels = [
    t(locale, liveWatch ? 'menu.liveOn' : 'menu.liveOff'),
    t(locale, actEnabled ? 'menu.actOn' : 'menu.actOff'),
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
