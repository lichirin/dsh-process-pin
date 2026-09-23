/**
 * dsh-process-pin — 宿主侧。
 *
 * 偏好写在本插件的 Config 里，并标成 volatile。设置服务按 profile 条目 id
 * `process-pin` 读这份 schema，浏览器侧用 configForms.get('process-pin') 读写。
 *
 * @module dsh-process-pin
 */
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-process-pin'

/** 与 cordis.patch.yml 里的条目 id、浏览器侧 configForms.get 使用同一个值。 */
export const SETTINGS_NAMESPACE = 'process-pin'

export const PINNED_FIELD = 'pinned'
export const ROW_PINNED_FIELD = 'rowPinned'
export const KEEP_ANCHOR_FIELD = 'keepAnchor'
export const HOTKEY_FIELD = 'collapseAllHotkey'

export const DEFAULTS = {
  [PINNED_FIELD]: true,
  [ROW_PINNED_FIELD]: true,
  [KEEP_ANCHOR_FIELD]: true,
  [HOTKEY_FIELD]: 'Ctrl+Alt+KeyC',
}

export const Config = z.object({
  [PINNED_FIELD]: z.boolean().default(DEFAULTS[PINNED_FIELD]).volatile(),
  [ROW_PINNED_FIELD]: z.boolean().default(DEFAULTS[ROW_PINNED_FIELD]).volatile(),
  [KEEP_ANCHOR_FIELD]: z.boolean().default(DEFAULTS[KEEP_ANCHOR_FIELD]).volatile(),
  [HOTKEY_FIELD]: z.string().default(DEFAULTS[HOTKEY_FIELD]).volatile(),
})

function apply() {}

export { apply }
