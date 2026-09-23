/**
 * dsh-process-pin — 浏览器侧 bundle（单文件，由 __ModuleLoader__ 加载）。
 *
 * 解决什么：会话里「轮次过程」的折叠控件（紧凑对话下那条
 * 「N 次工具调用 / 已思考」整行）以及展开的单条标题（Think 思维链行、
 * 工具卡、命令卡、上下文注入行……）都长在内容的**顶部**。过程一长，
 * 往下读完，标题早被顶出屏幕，想收起就得手动上滑很久。
 *
 * 做法：让这些标题行滑出会话滚动区顶部后**冻结在顶部**（Excel 冻结窗格），
 * 读完整段当场点一下即可收起。
 *
 *   A｜轮次过程总控件：宿主把它渲染成独立 flowItem，
 *      `.flowItem[data-chat-flow-key][data-chat-flow-kind="turn-process"] > button[data-turn-process]`。
 *      它自己的坑位高度 = 按钮高度，所以 sticky 只能打在外层 flowItem 上；
 *      而该 flowItem 的包含块是整条 `.column`，纯 CSS 会一路钉到会话结束。
 *      因此由 JS 判定「这一轮的过程行是否还压着视口顶边」，只在那期间加标注；
 *      吸附位置本身交给 sticky，JS 不参与逐帧定位（因此不会抖）。
 *      边界 = 最后一个过程组成员滑过顶边（即"进入最终答案就收"）；
 *      往上滑到过程行重新露头，标注会自动回来（判定无状态，不需要恢复操作）。
 *
 *   B｜展开的单条标题：`[data-open] > [data-disclosure-row]`。标题行的包含块
 *      正好是它自己的 root（标题 + 展开正文），所以 sticky 自带完美边界：
 *      正文读完自动脱开、下一条到顶自动接手，全程原生合成器驱动。
 *      嵌套在别的 disclosure 正文里的标题行会被跳过，避免两层都钉在 top:0 互相压住。
 *      父层钉住时，子层按父层**实测高度**让位（不硬编码 33px），形成两级冻结条。
 *
 *   C｜收起后保持阅读位置：宿主手动收起时会先把焦点移到过程控件再隐藏成员，
 *      浏览器可能因此带动一次滚动；插件在收起发生的同一批变更后、绘制之前
 *      补偿一次 scrollTop，让正在读的那段文字留在原处。
 *
 * DOM 契约（均已在 dsh 0.1.5-rc.1 的已安装构建中逐一核对）：
 *   [data-conversation-scroll]                          会话滚动区（真正的 scrollport）
 *   .flowItem[data-chat-flow-key][data-chat-turn][data-chat-flow-kind]
 *   button[data-turn-process][data-open]                轮次过程控件
 *   [data-turn-process-member]                          过程组成员
 *   [data-composer-seat]                                输入区（排除）
 *   [data-open] > [data-disclosure-row]                 DisclosureRow 展开态与标题行
 *   [data-disclosure-row][data-expandable]              整行可点；否则点赞内的 button[aria-expanded]
 *   hidden="until-found"                                宿主隐藏过程成员的方式
 *
 * 纯 DOM + CSS：不改宿主代码，不接管点击——点的是**原按钮本身**，
 * 焦点、aria 与宿主自己的收起逻辑原样保留。
 */

window.__ModuleLoader__.load({
  id: 'dsh-process-pin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const el = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // ───────────────────────────── 常量 ─────────────────────────────

    /** 本地化命名空间。 */
    const NS = 'process-pin'
    /** 设置命名空间（= settings.plugin.item 卡片寻址用的 key）。 */
    const SETTINGS_NAMESPACE = 'process-pin'
    const PINNED_FIELD = 'pinned'
    const ROW_PINNED_FIELD = 'rowPinned'
    const KEEP_ANCHOR_FIELD = 'keepAnchor'
    const HOTKEY_FIELD = 'collapseAllHotkey'
    const DEFAULT_HOTKEY = 'Ctrl+Alt+KeyC'

    const STYLE_ID = 'dsh-process-pin/styles.css'
    const ROOT_CLASS = 'dsh-pp-on'
    /** 标注：被冻结的「轮次过程控件」所在 flowItem。 */
    const PANEL_ATTR = 'data-dsh-pp-pinned'
    /** 标注：被冻结的 DisclosureRow 标题行。 */
    const ROW_ATTR = 'data-dsh-pp-row'
    /** 每元素缓存的底色（主题切换时失效重算）。 */
    const BG_VAR = '--dsh-pp-bg'
    /** 子层让位偏移。 */
    const TOP_VAR = '--dsh-pp-top'
    const FALLBACK_BG = 'var(--dsw-alias-bg-base)'

    const SCROLLPORT = '[data-conversation-scroll]'
    const FLOW_ITEM = '[data-chat-flow-key]'
    const CONTROL = 'button[data-turn-process][data-open]'
    const MEMBER_ATTR = 'data-turn-process-member'
    const ROW = '[data-disclosure-row]'
    const COMPOSER = '[data-composer-seat]'
    const PROCESS_KIND = 'turn-process'
    /** 静止后继续观察的帧数（宿主的 focus() 滚动可能晚于首次修正才落地）。 */
    const ANCHOR_PATIENCE = 12
    /** 硬上限，避免与别的滚动来源无限拉锯。 */
    const ANCHOR_MAX_FRAMES = 40
    /** 需要换落点时，线性滑过去用的帧数（≈12 帧 ≈ 200ms）。 */
    const GLIDE_FRAMES = 12
    /** 位移小于这个值就直接到位，不做滑动。 */
    const GLIDE_MIN_PX = 28

    const zh = {
      'card.name': '过程吸顶',
      'card.description': '让「轮次过程」控件与展开的单条标题在会话顶部冻结，读完整段当场收起。',
      'field.pinned': '轮次过程控件吸顶',
      'field.pinned.hint': '展开的「N 次工具调用 / 已思考」整行滑出顶部后，冻结在会话顶部；点它收起整轮过程。',
      'field.rowPinned': '单条标题吸顶',
      'field.rowPinned.hint': '展开的 Think / 工具卡 / 命令卡等标题行滑出顶部后，冻结在过程条下方，点它收起这一条。',
      'field.keepAnchor': '收起后保持阅读位置',
      'field.keepAnchor.hint': '收起时补偿滚动，避免正在读的文字被顶走。若收起后整篇比视口还短，则只能贴顶。',
      'field.hotkey': '「全部收起」快捷键',
      'field.hotkey.hint': '需含 Ctrl / Alt / ⌘ 之一；在输入框聚焦时同样生效。',
      'button.hotkey': '设置',
      'button.hotkey.armed': '请按新组合键…',
      'button.reset': '恢复默认',
      'header.collapseAll': '全部收起',
      'header.collapseAll.title': '收起会话里所有展开的过程区块',
      'header.collapseAll.none': '当前没有展开的过程区块',
    }
    const en = {
      'card.name': 'Process pin',
      'card.description': 'Freeze the turn-process control and expanded section headers at the top of the conversation.',
      'field.pinned': 'Pin the turn-process control',
      'field.pinned.hint': 'The expanded "N tool calls / Thought" row freezes at the top once scrolled past; click it to collapse the whole process.',
      'field.rowPinned': 'Pin expanded section headers',
      'field.rowPinned.hint': 'A scrolled-past Think / tool / command header freezes below the process bar; click it to collapse that section.',
      'field.keepAnchor': 'Keep my reading position when collapsing',
      'field.keepAnchor.hint': 'Compensates scrolling on collapse so the text you were reading stays put. If the page becomes shorter than the viewport, it can only stick to the top.',
      'field.hotkey': 'Collapse-all shortcut',
      'field.hotkey.hint': 'Must include Ctrl / Alt / ⌘; also works while the composer is focused.',
      'button.hotkey': 'Set',
      'button.hotkey.armed': 'Press a combo…',
      'button.reset': 'Reset',
      'header.collapseAll': 'Collapse all',
      'header.collapseAll.title': 'Collapse every expanded process section in this conversation',
      'header.collapseAll.none': 'Nothing is expanded right now',
    }

    // ───────────────────────────── 样式 ─────────────────────────────

    /**
     * 冻结样式。
     * - `position:sticky; top:0` 吸附在滚动区顶边；`z-index:6` 高于会话内容，
     *   低于宿主自己的目录条（7）与浮层（20+/100+）。
     * - 底色取每元素**实测**的表面色，正文从其下方滚过不会透出来。
     * - 过程条的 `::before` 盖住标题行上方的兄弟间距（16px 落在 margin 里，
     *   浏览器若按 margin box 计算吸附位置就会留缝）；正常时它会被滚动区裁掉。
     * - 单条标题让位 `--dsh-pp-top`（= 父层实测高度），并靠"淡蓝底 + 左侧强调线
     *   + 文字缩进"体现它是子层。
     */
    const PIN_CSS = `
/* dsh-process-pin: 把滑出顶部的过程控件 / 折叠行标题冻结在会话顶部 */
.dsh-pp-on [${PANEL_ATTR}]{position:sticky;top:0;z-index:6;background-color:var(${BG_VAR},${FALLBACK_BG})}
.dsh-pp-on [${PANEL_ATTR}]::before{content:"";position:absolute;left:0;right:0;bottom:100%;height:40px;background:inherit}
.dsh-pp-on [${PANEL_ATTR}]>button[data-turn-process]{border-bottom-color:var(--dsw-alias-border-l3)}
.dsh-pp-on [${ROW_ATTR}]{position:sticky;top:var(${TOP_VAR},0px);z-index:6;
background-color:var(${BG_VAR},${FALLBACK_BG});
background-image:linear-gradient(0deg, color-mix(in srgb, var(--dsw-alias-state-business-primary,#4d9fff) 7%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary,#4d9fff) 7%, transparent))}
.dsh-pp-on [${ROW_ATTR}]::after{content:"";position:absolute;left:0;top:3px;bottom:3px;width:2px;border-radius:1px;
background:var(--dsw-alias-state-business-primary,#4d9fff);opacity:.8}
.dsh-pp-on [${ROW_ATTR}]>:first-child{margin-left:9px}
`

    /** 头部按钮样式（沿用宿主 --dsw-* 令牌，自动跟随主题）。 */
    const BUTTON_CSS = `
.dsh-pp-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;font:inherit;
border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,transparent);
color:var(--dsw-alias-label-secondary,#c5c5c5);font-size:13px;line-height:18px;cursor:pointer;white-space:nowrap;
transition:background .15s ease,border-color .15s ease,color .15s ease}
.dsh-pp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));border-color:var(--dsw-alias-border-l3,#666)}
.dsh-pp-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d9fff);outline-offset:1px}
.dsh-pp-btn[data-count="0"]{opacity:.5}
.dsh-pp-btn svg{flex:none}
.dsh-pp-count{color:var(--dsw-alias-label-tertiary,#9b9b9b);font-variant-numeric:tabular-nums}
`

    /** 插件配置卡片样式（对齐宿主自带插件卡片的观感）。 */
    const CARD_CSS = `
.dsh-pp-card{border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-3,#1b1b1d);
border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dsh-pp-card[data-pp-open]{background:var(--dsw-alias-bg-layer-2,#232325);border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.45))}
.dsh-pp-cardHead{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;
border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsh-pp-cardHead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d9fff);outline-offset:-2px}
.dsh-pp-cardHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsh-pp-cardName{color:var(--dsw-alias-label-primary,#e8e8e8);font-size:15px;font-weight:600;line-height:1.4}
.dsh-pp-cardDesc{color:var(--dsw-alias-label-tertiary,#9b9b9b);font-size:13px;line-height:1.5}
.dsh-pp-chevron{color:var(--dsw-alias-label-tertiary,#9b9b9b);flex:none;transition:transform .16s}
.dsh-pp-card[data-pp-open] .dsh-pp-chevron{transform:rotate(180deg)}
.dsh-pp-cardBody{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));margin:0 16px;padding-bottom:10px}
.dsh-pp-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dsh-pp-field+.dsh-pp-field{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-pp-fieldHead{align-items:center;gap:12px;display:flex}
.dsh-pp-fieldLabel{min-width:0;color:var(--dsw-alias-label-primary,#e8e8e8);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.dsh-pp-hint{color:var(--dsw-alias-label-tertiary,#9b9b9b);margin:0;font-size:12px;line-height:1.5}
.dsh-pp-hotkeyRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.dsh-pp-kbd{border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,#232325);
border-radius:6px;padding:3px 9px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#e8e8e8);
font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-pp-mini{font:inherit;color:var(--dsw-alias-label-secondary,#c5c5c5);cursor:pointer;background:0 0;
border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));border-radius:8px;padding:3px 10px;font-size:12px;line-height:1.5}
.dsh-pp-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsh-pp-mini:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d9fff);outline-offset:1px}
.dsh-pp-mini[data-armed]{border-color:var(--dsw-alias-state-business-primary,#4d9fff);color:var(--dsw-alias-state-business-primary,#4d9fff)}
/* 开关：复刻宿主 Switch 的观感 */
.dsh-pp-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;
border-radius:10px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.35));cursor:pointer}
.dsh-pp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4d9fff)}
.dsh-pp-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d9fff);outline-offset:2px}
.dsh-pp-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);
transition:transform .12s ease}
.dsh-pp-switch[aria-checked="true"] .dsh-pp-thumb{transform:translate(16px)}
@media (prefers-reduced-motion:reduce){.dsh-pp-thumb,.dsh-pp-chevron{transition:none}}
`

    const ALL_CSS = PIN_CSS + BUTTON_CSS + CARD_CSS

    /** 幂等插入一个 style 标签（按 data-plugin-css 去重）。 */
    function ensureStyleTag(css) {
      if (typeof document === 'undefined') return null
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
      let tag = document.querySelector(selector)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-process-pin'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = css
        document.head.appendChild(tag)
      } else if (tag.textContent !== css) {
        tag.textContent = css
      }
      return tag
    }

    /** 带 getSnapshot/subscribe 的小 store。 */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          if (value === next) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    // ─────────────────────── 快捷键：规范形式 ↔ 展示 ───────────────────────

    /** 是否 macOS 系（决定 ⌃⌥⇧⌘ 还是 Ctrl/Alt/Shift/Meta）。 */
    function isMacLike() {
      return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
    }

    /** 把 event.code 变成人类可读的键名。 */
    function keyLabel(code) {
      if (/^Key[A-Z]$/.test(code)) return code.slice(3)
      if (/^Digit[0-9]$/.test(code)) return code.slice(5)
      const map = {
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        BracketLeft: '[',
        BracketRight: ']',
        Backquote: '`',
        Minus: '-',
        Equal: '=',
        Semicolon: ';',
        Quote: "'",
        Comma: ',',
        Period: '.',
        Slash: '/',
        Backslash: '\\',
        Space: 'Space',
        Enter: 'Enter',
        Tab: 'Tab',
        Delete: 'Del',
        Backspace: '⌫',
      }
      return map[code] === undefined ? code : map[code]
    }

    /** 组合键合法性：必须含 Ctrl/Alt/⌘ 之一，且不能用 Escape（宿主对话框占用）。 */
    function validHotkey(spec) {
      if (spec === null || typeof spec !== 'object') return false
      if (typeof spec.code !== 'string' || spec.code === '') return false
      if (spec.code === 'Escape' || spec.code === 'Esc') return false
      return spec.ctrl === true || spec.alt === true || spec.meta === true
    }

    /** 规范形式 → spec（如 `Ctrl+Alt+KeyC`）。 */
    function parseHotkey(text) {
      const parts = String(text === undefined || text === null ? '' : text)
        .split('+')
        .map((part) => part.trim())
        .filter((part) => part !== '')
      if (parts.length < 2) return null
      const code = parts[parts.length - 1]
      const mods = parts.slice(0, -1).map((part) => part.toLowerCase())
      const spec = {
        ctrl: mods.indexOf('ctrl') >= 0,
        alt: mods.indexOf('alt') >= 0,
        shift: mods.indexOf('shift') >= 0,
        meta: mods.indexOf('meta') >= 0 || mods.indexOf('cmd') >= 0,
        code,
      }
      return validHotkey(spec) ? spec : null
    }

    /** spec → 规范形式。 */
    function serializeHotkey(spec) {
      const parts = []
      if (spec.ctrl) parts.push('Ctrl')
      if (spec.alt) parts.push('Alt')
      if (spec.shift) parts.push('Shift')
      if (spec.meta) parts.push('Meta')
      parts.push(spec.code)
      return parts.join('+')
    }

    /** spec → 展示文案（macOS 用符号）。 */
    function formatHotkey(spec) {
      const mac = isMacLike()
      const parts = []
      if (spec.ctrl) parts.push(mac ? '⌃' : 'Ctrl')
      if (spec.alt) parts.push(mac ? '⌥' : 'Alt')
      if (spec.shift) parts.push(mac ? '⇧' : 'Shift')
      if (spec.meta) parts.push(mac ? '⌘' : 'Meta')
      parts.push(keyLabel(spec.code))
      return parts.join('+')
    }

    // ────────────────── 底色解析：找到标题行背后不透明的表面色 ──────────────────

    const TRANSPARENT = /^(transparent|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i

    /** 从 rgb()/rgba() 取 alpha；解析不了（如 color-mix 产出的 color(srgb …)）就当不透明。 */
    function alphaOf(color) {
      const match = /^rgba?\(([^)]+)\)$/i.exec(color)
      if (match === null) return 1
      const parts = match[1].split(/[,\s/]+/).filter((part) => part !== '')
      if (parts.length < 4) return 1
      const raw = parts[3]
      const value = Number.parseFloat(raw)
      if (!Number.isFinite(value)) return 1
      return raw.charAt(raw.length - 1) === '%' ? value / 100 : value
    }

    /** 沿祖先链找最近的、看起来不透明的背景色。 */
    function opaqueBackgroundOf(node) {
      let current = node.parentElement
      let depth = 0
      while (current !== null && depth < 40) {
        const color = window.getComputedStyle(current).backgroundColor
        if (color !== '' && color !== null && !TRANSPARENT.test(color) && alphaOf(color) >= 0.9) return color
        current = current.parentElement
        depth += 1
      }
      return ''
    }

    /** 解析一次并缓存（getComputedStyle 不便宜，只在状态变化时调用）。 */
    function resolveSurface(node) {
      if (node.style.getPropertyValue(BG_VAR) !== '') return
      const color = opaqueBackgroundOf(node)
      if (color !== '') node.style.setProperty(BG_VAR, color)
    }

    // ─────────────────────────── 会话区遍历 ───────────────────────────

    /** 遍历所有可见的会话滚动区（子代理会话面板同样适用）。 */
    function eachScrollport(visit) {
      for (const viewport of document.querySelectorAll(SCROLLPORT)) {
        if (!(viewport instanceof HTMLElement)) continue
        const rect = viewport.getBoundingClientRect()
        if (rect.width < 2 && rect.height < 2) continue
        visit(viewport, rect)
      }
    }

    /** 该元素（或祖先）是否被宿主隐藏（hidden="until-found"）。 */
    function isHiddenDeep(node) {
      return node.closest('[hidden]') !== null
    }

    /** 会话流里所有展开且可见的区块（过程控件 + 单条标题），用于计数与"全部收起"。 */
    function expandedSections() {
      const found = []
      eachScrollport((viewport) => {
        for (const control of viewport.querySelectorAll('button[data-turn-process][data-open]')) {
          if (isHiddenDeep(control)) continue
          found.push(control)
        }
        for (const row of viewport.querySelectorAll('[data-open] > [' + ROW.slice(1, -1) + ']')) {
          if (isHiddenDeep(row)) continue
          if (row.closest(COMPOSER) !== null) continue
          found.push(row)
        }
      })
      return found
    }

    /** 一个 DisclosureRow 的点击目标（整行可点，或点赞内的 button[aria-expanded]）。 */
    function rowToggleTarget(row) {
      if (row.hasAttribute('data-expandable')) return row
      const button = row.querySelector('button[aria-expanded]')
      return button === null ? row : button
    }

    // ───────────────────────────── 冻结引擎 ─────────────────────────────

    /**
     * 这一轮「过程」的下沿：取**过程组成员**与**该轮里的折叠块**中底边最靠下的那个。
     *
     * 为什么必须带上折叠块：思维链（Think）长在**回答节点内部**——宿主把 reasoning
     * 块渲染成 ReasoningRow（DisclosureRow），它不属于过程组成员。只看成员会出现两种
     * "总控件该出现却不出现"：
     *   ① 纯思维的轮次（没有工具调用 → 没有成员）→ 永远判定为不活跃，条子从不出现；
     *   ② 成员读完后继续读同一轮的思维链 → 成员已滑过顶边，被判成"已进入最终答案"提前摘掉。
     * 折叠块要取**标题+正文的那个 root**而不是标题行本身：思维链展开时正文很长，
     * 只算 24px 的标题行会在你还在读正文时就认定过程结束了。
     * @returns 下沿元素（取不到时为 null）。
     */
    function groupEndNode(wrapper) {
      const turn = wrapper.getAttribute('data-chat-turn')
      let boundary = null
      let boundaryBottom = -Infinity
      const consider = (node) => {
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        if (rect.bottom > boundaryBottom) {
          boundary = node
          boundaryBottom = rect.bottom
        }
      }
      let node = wrapper.nextElementSibling
      while (node !== null) {
        const kind = node.getAttribute('data-chat-flow-kind')
        if (kind === PROCESS_KIND) break
        if (kind !== null) {
          const nodeTurn = node.getAttribute('data-chat-turn')
          if (turn === null || nodeTurn === null || nodeTurn === turn) {
            if (node.hasAttribute(MEMBER_ATTR)) {
              consider(node)
            } else {
              // 成员内部的折叠块不可能超出成员本身，不必扫；只扫成员之外的那些节点
              // （回答节点就是思维链的家）。
              for (const row of node.querySelectorAll(ROW)) {
                const host = row.parentElement
                consider(
                  host !== null && !host.hasAttribute('data-chat-flow-key') ? host : row,
                )
              }
            }
          }
        }
        node = node.nextElementSibling
      }
      return boundary
    }

    /** 这一轮的过程内容是否还压着视口顶边（= 还在读过程，而不是已经读完进了正文之后）。 */
    function groupAlive(wrapper, scrollTop) {
      const boundary = groupEndNode(wrapper)
      if (boundary === null) return false
      return boundary.getBoundingClientRect().bottom > scrollTop
    }

    /** 这个标题行是否嵌在另一个 disclosure 的正文里（嵌套的会被跳过，避免互相压住）。 */
    function isNestedDisclosure(row, viewport) {
      let node = row.parentElement
      while (node !== null && node !== viewport) {
        if (node.hasAttribute('data-open')) {
          const own = node.querySelector(':scope > [data-disclosure-row]')
          if (own !== null && own !== row) return true
        }
        node = node.parentElement
      }
      return false
    }

    /** 摘掉 keep 之外的标注、给 keep 打上标注（含底色解析）。 */
    function reconcile(attr, keep) {
      for (const node of document.querySelectorAll('[' + attr + ']')) {
        if (keep.has(node)) continue
        node.removeAttribute(attr)
        node.style.removeProperty(BG_VAR)
      }
      for (const node of keep) {
        if (!node.hasAttribute(attr)) node.setAttribute(attr, '')
        resolveSurface(node)
      }
    }

    /**
     * 找到"阅读线"上的那块**内容**（视口顶边之下第一块）。
     * 必须跳过过程控件：它吸顶后自己就贴在视口顶边，会被误当成内容，
     * 而它既不移动也不会被隐藏，锚定补偿会因此永远算出 0。
     */
    function flowItemAtLine(viewport, scrollTop) {
      for (const item of viewport.querySelectorAll(FLOW_ITEM)) {
        if (item.getAttribute('data-chat-flow-kind') === PROCESS_KIND) continue
        if (item.hasAttribute(PANEL_ATTR)) continue
        const rect = item.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        if (rect.bottom > scrollTop + 1) return item
      }
      return null
    }

    /**
     * 创建一个冻结控制器（一个插件实例一份）。
     * @param options - { panel, row, anchor } 三个开关的实时值。
     * @returns 控制句柄。
     */
    function createEngine(getOptions) {
      let rafPending = false
      let disposed = false
      let anchor = null
      /** 调试计数：锚定被触发几次、跑了几帧、最后一次修正量、走了哪条路。 */
      let armCount = 0
      let stepCount = 0
      let lastDelta = 0
      let lastMode = 'idle'
      const countStore = createStore(0)

      /** 清掉所有标注与缓存底色。 */
      function clearMarks() {
        for (const attr of [PANEL_ATTR, ROW_ATTR]) {
          for (const node of document.querySelectorAll('[' + attr + ']')) {
            node.removeAttribute(attr)
            node.style.removeProperty(BG_VAR)
          }
        }
      }

      /** 主题切换后底色可能变了：丢掉缓存并重算。 */
      function invalidate() {
        for (const node of document.querySelectorAll('[' + PANEL_ATTR + '],[' + ROW_ATTR + ']')) {
          node.style.removeProperty(BG_VAR)
        }
        schedule()
      }

      /** 重算一次：谁该被冻结。 */
      function update() {
        if (disposed) return
        const options = getOptions()
        const keepPanels = new Set()
        const keepRows = new Set()

        if (options.panel || options.row) {
          eachScrollport((viewport, viewportRect) => {
            const scrollTop = viewportRect.top
            let panel = null

            if (options.panel) {
              let winnerTop = -Infinity
              for (const control of viewport.querySelectorAll(CONTROL)) {
                const wrapper = control.closest(FLOW_ITEM)
                if (!(wrapper instanceof HTMLElement)) continue
                const top = wrapper.getBoundingClientRect().top
                const pinned = wrapper.hasAttribute(PANEL_ATTR)
                // 已钉住的元素此刻正贴在顶边，所以"已钉住"必须算作仍可钉，
                // 否则会出现 钉住→判定失效→摘掉→又该钉住 的抖动。
                if (!pinned && top > scrollTop + 1) continue
                if (!groupAlive(wrapper, scrollTop)) continue
                if (top > winnerTop) {
                  panel = wrapper
                  winnerTop = top
                }
              }
              if (panel !== null) keepPanels.add(panel)
            }

            if (options.row) {
              // 子层按父层**实测高度**让位，而不是硬编码 33px。
              let offset = '0px'
              if (panel !== null) {
                const height = panel.getBoundingClientRect().height
                if (height > 1) offset = Math.round(height) + 'px'
              }
              for (const row of viewport.querySelectorAll(ROW)) {
                if (!(row instanceof HTMLElement)) continue
                if (row.closest(COMPOSER) !== null) continue
                if (isHiddenDeep(row)) continue
                const root = row.parentElement
                if (root === null || !root.hasAttribute('data-open')) continue
                if (isNestedDisclosure(row, viewport)) continue
                if (row.style.getPropertyValue(TOP_VAR) !== offset) row.style.setProperty(TOP_VAR, offset)
                keepRows.add(row)
              }
            }
          })
        }

        reconcile(PANEL_ATTR, keepPanels)
        reconcile(ROW_ATTR, keepRows)
        countStore.set(expandedSections().length)
      }

      /** 一帧内只重算一次（滚动与流式输出都是高频触发）。 */
      function schedule() {
        if (rafPending || disposed) return
        rafPending = true
        requestAnimationFrame(() => {
          rafPending = false
          update()
        })
      }

      // ── C：收起后的滚动锚定补偿 ──

      /**
       * 临时让这一次 focus() 不带滚动。
       * 宿主手动收起时会把焦点移到过程控件（这是它的无障碍意图，保留），
       * 但浏览器为此会把视口拽回控件所在位置——位置我们自己在下面保持，
       * 所以只摘掉这一次的滚动副作用，焦点照旧。宿主同步调用后即还原。
       */
      function suppressFocusScroll(node) {
        if (node === null || node === undefined || typeof node.focus !== 'function') return
        if (node.__dshPpFocusPatched === true) return
        const original = node.focus
        node.focus = function (options) {
          try {
            return original.call(this, Object.assign({}, options, { preventScroll: true }))
          } catch (error) {
            return original.call(this, options)
          }
        }
        node.__dshPpFocusPatched = true
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (node.__dshPpFocusPatched !== true) return
            node.focus = original
            node.__dshPpFocusPatched = false
          }),
        )
      }

      /**
       * 这次点击会收掉哪一块内容。
       * - 点单条标题行：折叠区 = 它自己的 root（标题 + 展开正文）
       * - 点过程总控件：折叠区 = 它之后的过程组成员
       * @returns {{first: Element, last: Element}|null}
       */
      function collapseRegion(target) {
        const row = target.closest('[' + ROW_ATTR + ']')
        if (row !== null) {
          const root = row.parentElement
          if (root === null) return null
          return { first: root, last: root }
        }
        const panel = target.closest('[' + PANEL_ATTR + ']')
        if (panel === null) return null
        const members = []
        let node = panel.nextElementSibling
        while (node !== null) {
          if (node.getAttribute('data-chat-flow-kind') === PROCESS_KIND) break
          if (node.hasAttribute(MEMBER_ATTR)) members.push(node)
          node = node.nextElementSibling
        }
        if (members.length === 0) return { first: panel, last: panel }
        return { first: members[0], last: members[members.length - 1] }
      }

      /** 这个节点是否落在本次要收掉的折叠区里（含被包含与文档顺序介于两者之间）。 */
      function inRegion(region, node) {
        if (region === null || node === null || !(node instanceof Node)) return false
        if (region.first === node || region.last === node) return true
        if (region.first.contains(node) || region.last.contains(node)) return true
        const afterFirst = (region.first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        const beforeLast = (node.compareDocumentPosition(region.last) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        return afterFirst && beforeLast
      }

      /**
       * 视口顶边那条**文字**（跳过我自己那两条冻结条——它们就贴在顶边，
       * 不跳过的话永远只会命中冻结条自己，锚定就恒等于"不动"）。
       * @returns 命中的元素，取不到时回落到传入的 flowItem。
       */
      function readingNodeAt(viewport, portTop, fallback) {
        if (typeof document.elementsFromPoint !== 'function') return fallback
        const box = viewport.getBoundingClientRect()
        if (box.width < 8) return fallback
        const x = box.left + Math.min(Math.max(box.width * 0.5, 24), Math.max(24, box.width - 24))
        for (const node of document.elementsFromPoint(x, portTop + 1)) {
          if (!(node instanceof Element)) continue
          if (node === viewport || !viewport.contains(node)) continue
          if (node.closest('[' + PANEL_ATTR + ']') !== null) continue
          if (node.closest('[' + ROW_ATTR + ']') !== null) continue
          return node
        }
        return fallback
      }

      /** 折叠区之后第一块**会留下来**的内容（文档顺序，跳过被隐藏的）。 */
      function firstContentAfter(region, viewport) {
        let passed = false
        for (const item of viewport.querySelectorAll(FLOW_ITEM)) {
          if (!passed) {
            if (item === region.last || item.contains(region.last)) passed = true
            continue
          }
          if (isHiddenDeep(item)) continue
          const rect = item.getBoundingClientRect()
          if (rect.width > 0 || rect.height > 0) return item
        }
        return null
      }

      /** 此刻仍卡在顶部的冻结条下沿（相对滚动区顶边）；没有则为 0。 */
      function frozenBelow(viewport, portTop) {
        let bottom = 0
        for (const node of viewport.querySelectorAll('[' + PANEL_ATTR + '],[' + ROW_ATTR + ']')) {
          const offset = node.getBoundingClientRect().bottom - portTop
          if (offset > bottom && offset < 80) bottom = offset
        }
        return bottom
      }

      /**
       * 在"会触发收起"的点击到达宿主之前算好四件事：
       *   1. 阅读线上那块 flowItem（经典锚定的回落目标）；
       *   2. 视口顶边那条**实际文字**（判断"我正在读的东西会不会被删掉"）；
       *   3. 这一次会被收掉的折叠区（单条标题的 root，或过程控件的组成员）；
       *   4. 折叠区之后第一块会留下来的内容（文字被删时用它当落点）。
       *
       * 判据是"**视口顶边那条文字**是否落在折叠区里"，不是"折叠区是否盖住顶边"：
       * 收起一条标题行时，装着它的 flowItem 既不会消失、顶边也不动，
       * 只看流元素或几何覆盖会算错——要么永远算出 0，要么把没被删的文字也一起挪走。
       */
      function armAnchor(target) {
        if (getOptions().anchor !== true) return
        const viewport = target.closest(SCROLLPORT)
        if (!(viewport instanceof HTMLElement)) return
        const portTop = viewport.getBoundingClientRect().top
        const line = flowItemAtLine(viewport, portTop)
        if (line === null) return
        // 宿主可能把焦点移到被点的那个元素（按钮，或带 tabindex 的标题行）——
        // 两种都摘掉这一次的滚动副作用。
        suppressFocusScroll(target.closest('button'))
        suppressFocusScroll(target.closest('[tabindex]'))
        armCount += 1

        const region = collapseRegion(target)
        const readingNode = readingNodeAt(viewport, portTop, line)
        // deleted=true 表示"我正在读的文字会被删掉"：那种情况下才需要换落点，
        // 也才允许移动视口（滑动）。文字还在时一个像素都不该动。
        const deleted = region !== null && inRegion(region, readingNode)
        const survivor = region === null ? null : firstContentAfter(region, viewport)

        anchor = {
          viewport,
          line,
          top: line.getBoundingClientRect().top,
          portTop,
          deleted,
          survivor,
          region: region === null ? null : region.last,
          glide: GLIDE_FRAMES,
          patience: ANCHOR_PATIENCE,
          budget: ANCHOR_MAX_FRAMES,
        }
        stepAnchor()
      }

      /**
       * 每帧把阅读位置按回去（最多 budget 帧，静止即停）：
       * - 我正在读的文字**还在** → 让它回到原来的视口位置（精确、瞬时，一个像素都不动）；
       * - 我正在读的文字**被删了** → 那段已经不存在，只能换落点：把折叠区之后的第一块
       *   内容顶到视口顶边（父层冻结条还在就顶到它下面）。这时不瞬移，而是用约
       *   GLIDE_FRAMES 帧线性滑过去，让人看得出"页面在移动"而不是被瞬移。
       */
      function stepAnchor() {
        if (anchor === null || disposed) return
        requestAnimationFrame(() => {
          const state = anchor
          if (state === null || disposed) return
          state.budget -= 1
          stepCount += 1
          if (!state.viewport.isConnected) {
            anchor = null
            return
          }

          const rect = state.line.getBoundingClientRect()
          // 看宿主契约（hidden 属性）而不只是几何：hidden="until-found"
          // （content-visibility:hidden）仍会报告记住的尺寸，几何看起来"还在"。
          const lineGone = isHiddenDeep(state.line) || (rect.width === 0 && rect.height === 0)

          let delta = 0
          if (state.deleted || lineGone) {
            lastMode = 'align'
            if (state.survivor === null || !state.survivor.isConnected || isHiddenDeep(state.survivor)) {
              state.survivor = state.region === null ? null : firstContentAfter({ last: state.region }, state.viewport)
            }
            if (state.survivor === null) {
              anchor = null
              return
            }
            const wantTop = state.portTop + frozenBelow(state.viewport, state.portTop)
            delta = state.survivor.getBoundingClientRect().top - wantTop
          } else {
            lastMode = 'hold'
            delta = rect.top - state.top
          }

          if (Math.abs(delta) > 0.5) {
            // 文字被删掉、必须换落点时才滑动（线性分帧，看得出页面在移动而不是被瞬移）；
            // 文字还在时精确一次到位，一个像素都不多动。
            if (state.deleted && state.glide > 1 && Math.abs(delta) > GLIDE_MIN_PX) {
              state.viewport.scrollTop += delta / state.glide
              state.glide -= 1
            } else {
              state.viewport.scrollTop += delta
            }
            // 我们自己动了视口 → 冻结状态必须跟着重算。
            // 不能只等 scroll 事件：补偿期间用户没在滚，而"过程读完就撤"这类判定依赖滚动位置。
            schedule()
            // 位置还在动（宿主 focus 滚动、React 异步提交）→ 重新给足耐心
            state.patience = ANCHOR_PATIENCE
          }
          lastDelta = delta
          state.patience -= 1
          if (state.patience <= 0 || state.budget <= 0) anchor = null
          else stepAnchor()
        })
      }

      return {
        countStore,
        schedule,
        invalidate,
        armAnchor,
        /** 用户自己开始滚动（滚轮/触摸/按键）→ 立刻停止补偿，绝不跟用户抢。 */
        cancelAnchor() {
          anchor = null
        },
        /** 调试：锚定统计（供真机排查与测试台断言）。 */
        anchorStats: () => ({
          armed: armCount,
          steps: stepCount,
          delta: Math.round(lastDelta),
          mode: lastMode,
        }),
        /** 开关变化：关掉的层立刻摘标注。 */
        applyOptions() {
          const options = getOptions()
          if (options.panel !== true) {
            for (const node of document.querySelectorAll('[' + PANEL_ATTR + ']')) {
              node.removeAttribute(PANEL_ATTR)
              node.style.removeProperty(BG_VAR)
            }
          }
          if (options.row !== true) {
            for (const node of document.querySelectorAll('[' + ROW_ATTR + ']')) {
              node.removeAttribute(ROW_ATTR)
              node.style.removeProperty(BG_VAR)
            }
          }
          schedule()
        },
        dispose() {
          disposed = true
          anchor = null
          clearMarks()
          countStore.set(0)
        },
      }
    }

    // ─────────────────────────── 设置策略 ───────────────────────────

    /** 把设置快照收敛成插件内部形态（坏值一律回落到默认）。 */
    function normalizeSettings(value) {
      const source = value === undefined || value === null ? {} : value
      const hotkey = parseHotkey(source[HOTKEY_FIELD])
      return {
        [PINNED_FIELD]: source[PINNED_FIELD] !== false,
        [ROW_PINNED_FIELD]: source[ROW_PINNED_FIELD] !== false,
        [KEEP_ANCHOR_FIELD]: source[KEEP_ANCHOR_FIELD] !== false,
        [HOTKEY_FIELD]: hotkey === null ? DEFAULT_HOTKEY : serializeHotkey(hotkey),
      }
    }

    /**
     * 设置策略：读宿主设置，写回宿主设置。
     * 设置未就绪（loading/unavailable）时保持默认值，避免把默认值写坏。
     */
    function createPolicy(scope) {
      const store = createStore(normalizeSettings(undefined))
      const adopt = () => {
        const snapshot = scope.getSnapshot()
        if (snapshot.status !== 'ready' || snapshot.value === undefined) return
        store.set(normalizeSettings(snapshot.value))
      }
      scope.subscribe(adopt)
      adopt()
      return {
        store,
        /** 单字段写入：先本地生效，再写回宿主；失败则回到宿主真相。 */
        set(field, value) {
          store.set(Object.assign({}, store.getSnapshot(), { [field]: value }))
          try {
            const result = scope.set(field, value)
            if (result !== undefined && typeof result.catch === 'function') result.catch(() => adopt())
          } catch {
            adopt()
          }
        },
      }
    }

    // ──────────────────────────── 图标 ────────────────────────────

    /** 向上双箭头（"全部收起"）。 */
    function CollapseIcon() {
      return el(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        el('path', {
          d: 'M3.5 6.5 7 3l3.5 3.5M3.5 10.5 7 7l3.5 3.5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** 卡片头部的展开箭头。 */
    function ChevronIcon() {
      return el(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true', className: 'dsh-pp-chevron' },
        el('path', {
          d: 'M3.5 5.25 7 8.75l3.5-3.5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** 开关（复刻宿主 Switch 的观感与无障碍语义）。 */
    function Switch(props) {
      return el(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'dsh-pp-switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          title: props.label,
          onClick: () => props.onChange(!props.checked),
        },
        el('span', { className: 'dsh-pp-thumb' }),
      )
    }

    /** 一行"标题 + 开关 + 说明"。 */
    function Field(props) {
      return el(
        'div',
        { className: 'dsh-pp-field' },
        el(
          'div',
          { className: 'dsh-pp-fieldHead' },
          el('span', { className: 'dsh-pp-fieldLabel' }, props.label),
          el(Switch, { checked: props.checked, onChange: props.onChange, label: props.label }),
        ),
        props.hint === undefined ? null : el('p', { className: 'dsh-pp-hint' }, props.hint),
      )
    }

    // ──────────────────── 设置 → 插件 → 过程吸顶 卡片 ────────────────────

    /** 本插件的配置卡片（挂进 settings.plugin.item，key = process-pin）。 */
    function ProcessPinCard(props) {
      const { t, useSettings, setField } = props
      const settings = useSettings((value) => value)
      const [open, setOpen] = useState(true)
      const [capturing, setCapturing] = useState(false)

      // 捕获新快捷键：按下即生效；Esc 取消；忽略只按修饰键与 IME 组合。
      useEffect(() => {
        if (!capturing) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setCapturing(false)
            return
          }
          if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') return
          if (event.isComposing) return
          const spec = {
            ctrl: event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
            meta: event.metaKey,
            code: event.code,
          }
          if (!validHotkey(spec)) return
          if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return
          event.preventDefault()
          event.stopPropagation()
          setField(HOTKEY_FIELD, serializeHotkey(spec))
          setCapturing(false)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [capturing, setField])

      const spec = parseHotkey(settings[HOTKEY_FIELD]) || parseHotkey(DEFAULT_HOTKEY)
      const hotkeyLabel = formatHotkey(spec)

      return el(
        'li',
        { className: 'dsh-pp-card', 'data-pp-open': open ? '' : undefined },
        el(
          'button',
          {
            type: 'button',
            className: 'dsh-pp-cardHead',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen(!open),
          },
          el(
            'span',
            { className: 'dsh-pp-cardHeadText' },
            el('span', { className: 'dsh-pp-cardName' }, t('card.name')),
            el('span', { className: 'dsh-pp-cardDesc' }, t('card.description')),
          ),
          el(ChevronIcon, null),
        ),
        open
          ? el(
              'div',
              { className: 'dsh-pp-cardBody' },
              el(Field, {
                label: t('field.pinned'),
                hint: t('field.pinned.hint'),
                checked: settings[PINNED_FIELD] === true,
                onChange: (next) => setField(PINNED_FIELD, next),
              }),
              el(Field, {
                label: t('field.rowPinned'),
                hint: t('field.rowPinned.hint'),
                checked: settings[ROW_PINNED_FIELD] === true,
                onChange: (next) => setField(ROW_PINNED_FIELD, next),
              }),
              el(Field, {
                label: t('field.keepAnchor'),
                hint: t('field.keepAnchor.hint'),
                checked: settings[KEEP_ANCHOR_FIELD] === true,
                onChange: (next) => setField(KEEP_ANCHOR_FIELD, next),
              }),
              el(
                'div',
                { className: 'dsh-pp-field' },
                el(
                  'div',
                  { className: 'dsh-pp-fieldHead' },
                  el('span', { className: 'dsh-pp-fieldLabel' }, t('field.hotkey')),
                  el(
                    'span',
                    { className: 'dsh-pp-hotkeyRow' },
                    el('span', { className: 'dsh-pp-kbd' }, capturing ? t('button.hotkey.armed') : hotkeyLabel),
                    el(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-pp-mini',
                        'data-armed': capturing ? '' : undefined,
                        onClick: () => setCapturing(!capturing),
                      },
                      capturing ? t('button.hotkey.armed') : t('button.hotkey'),
                    ),
                    el(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-pp-mini',
                        onClick: () => {
                          setCapturing(false)
                          setField(HOTKEY_FIELD, DEFAULT_HOTKEY)
                        },
                      },
                      t('button.reset'),
                    ),
                  ),
                ),
                el('p', { className: 'dsh-pp-hint' }, t('field.hotkey.hint')),
              ),
            )
          : null,
      )
    }

    // ────────────────── 会话头部：全部收起 ──────────────────

    /** 会话头部工具区的「全部收起」（带展开计数）。 */
    function HeaderCollapseAllButton(props) {
      const { t, useCount, collapseAll } = props
      const count = useCount((value) => value)
      const label = t('header.collapseAll')
      return el(
        'button',
        {
          type: 'button',
          className: 'dsh-pp-btn',
          'data-count': String(count),
          'aria-disabled': count === 0 ? 'true' : 'false',
          title: count === 0 ? t('header.collapseAll.none') : t('header.collapseAll.title'),
          onClick: collapseAll,
        },
        el(CollapseIcon, null),
        el('span', null, label),
        count > 0 ? el('span', { className: 'dsh-pp-count' }, '·' + count) : null,
      )
    }

    // ──────────────────────────── 插件主体 ────────────────────────────

    const inject = ['slots', 'locale', 'configForms', 'remote']

    /**
     * 挂载：注入样式、建立冻结引擎、注册配置卡片与会话头部按钮。
     * @param ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      // 1) 本地化
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'process-pin: dictionaries')
      const t = ctx.locale.bind(NS)

      // 2) 样式（ctx.effect 托管；被移除会自动补回）
      ctx.effect(() => {
        const tag = ensureStyleTag(ALL_CSS)
        const observer =
          typeof MutationObserver === 'undefined'
            ? null
            : new MutationObserver(() => {
                if (tag !== null && !tag.isConnected) ensureStyleTag(ALL_CSS)
              })
        if (observer !== null) observer.observe(document.head, { childList: true })
        return () => {
          if (observer !== null) observer.disconnect()
          if (tag !== null && tag.isConnected) tag.remove()
        }
      }, 'process-pin: stylesheet')

      // 3) 设置策略（开关实时值 + 快捷键）
      const policy = createPolicy(ctx.configForms.get(SETTINGS_NAMESPACE))
      const currentHotkey = () => {
        const spec = parseHotkey(policy.store.getSnapshot()[HOTKEY_FIELD])
        return spec === null ? parseHotkey(DEFAULT_HOTKEY) : spec
      }

      // 4) 冻结引擎 + 交互（引擎实例在此建立，配置卡片与头部按钮共用同一份）
      let engine = null
      let collapseAll = () => {}
      ctx.effect(() => {
        engine = createEngine(() => {
          const settings = policy.store.getSnapshot()
          return {
            panel: settings[PINNED_FIELD] === true,
            row: settings[ROW_PINNED_FIELD] === true,
            anchor: settings[KEEP_ANCHOR_FIELD] === true,
          }
        })

        /**
         * 收起会话里所有展开的过程区块（可见的，且不在输入区内）。
         *
         * 每次点击前**重新确认当前状态**：面板先被收起后，它内部的标题行会随之隐藏
         * 甚至已经关闭；拿着开始时算好的列表一路点下去，会把那些已经关掉的又点开。
         */
        collapseAll = () => {
          for (const section of expandedSections()) {
            if (!section.isConnected || isHiddenDeep(section)) continue
            if (section.tagName === 'BUTTON') {
              if (!section.hasAttribute('data-open')) continue
              section.click()
              continue
            }
            const root = section.parentElement
            if (root === null || !root.hasAttribute('data-open')) continue
            rowToggleTarget(section).click()
          }
        }

        const onClickCapture = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          // 只有点在"被冻结的那一条"上才做锚定补偿（它必然是收起动作）。
          if (target.closest('[' + PANEL_ATTR + ']') !== null) {
            engine.armAnchor(target)
            return
          }
          if (target.closest('[' + ROW_ATTR + ']') !== null) engine.armAnchor(target)
        }

        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing) return
          const spec = currentHotkey()
          if (event.code !== spec.code) return
          if (
            event.ctrlKey !== spec.ctrl ||
            event.altKey !== spec.alt ||
            event.shiftKey !== spec.shift ||
            event.metaKey !== spec.meta
          ) {
            return
          }
          // AltGr 在部分键盘布局上报成 Ctrl+Alt，绝不能拦它输入的字符。
          if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return
          event.preventDefault()
          collapseAll()
        }

        const contentObserver =
          typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => engine.schedule())
        if (contentObserver !== null) {
          contentObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-open', 'hidden', 'data-turn-process-hidden'],
          })
        }
        // 主题切换：body 上的 data-ds-dark-theme / class 变化 → 底色缓存失效
        const themeObserver =
          typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => engine.invalidate())
        if (themeObserver !== null && document.body !== null) {
          themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-ds-dark-theme', 'class'],
          })
        }

        const onScroll = () => engine.schedule()
        const onResize = () => engine.schedule()
        const onUserScrollIntent = () => engine.cancelAnchor()
        document.addEventListener('scroll', onScroll, { capture: true, passive: true })
        window.addEventListener('resize', onResize)
        window.addEventListener('wheel', onUserScrollIntent, { capture: true, passive: true })
        window.addEventListener('touchstart', onUserScrollIntent, { capture: true, passive: true })
        document.addEventListener('click', onClickCapture, true)
        document.addEventListener('keydown', onKeyDown, true)
        document.documentElement.classList.add(ROOT_CLASS)

        const unsubscribe = policy.store.subscribe(() => engine.applyOptions())
        engine.applyOptions()

        window.dshProcessPin = {
          version: '0.1.0',
          pinned: () => document.querySelectorAll('[' + PANEL_ATTR + ']').length,
          rows: () => document.querySelectorAll('[' + ROW_ATTR + ']').length,
          count: () => engine.countStore.getSnapshot(),
          hotkey: () => formatHotkey(currentHotkey()),
          anchorStats: () => engine.anchorStats(),
          collapseAll,
        }

        return () => {
          unsubscribe()
          if (contentObserver !== null) contentObserver.disconnect()
          if (themeObserver !== null) themeObserver.disconnect()
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          window.removeEventListener('wheel', onUserScrollIntent, true)
          window.removeEventListener('touchstart', onUserScrollIntent, true)
          document.removeEventListener('click', onClickCapture, true)
          document.removeEventListener('keydown', onKeyDown, true)
          document.documentElement.classList.remove(ROOT_CLASS)
          engine.dispose()
          if (window.dshProcessPin !== undefined) {
            try {
              delete window.dshProcessPin
            } catch {
              window.dshProcessPin = undefined
            }
          }
        }
      }, 'process-pin: pin engine')

      // 5) 设置 → 插件 里的本插件页
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugins.tab', () =>
            ctx.slots.register(
              {
                name: 'settings.plugins.tab',
                id: SETTINGS_NAMESPACE,
                order: 40,
                label: () => t('card.name'),
                locale: NS,
                inject: () => ({
                  hooks: { settings: policy.store },
                  setField: policy.set,
                }),
              },
              ProcessPinCard,
            ),
          ),
        'process-pin: settings card',
      )

      // 6) 会话头部：全部收起
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'process-pin',
                order: 31,
                locale: NS,
                inject: () => ({
                  hooks: { count: engine.countStore },
                  collapseAll: () => collapseAll(),
                }),
              },
              HeaderCollapseAllButton,
            ),
          ),
        'process-pin: header button',
      )

    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
