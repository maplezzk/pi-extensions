/**
 * 本扩展在会话区里的提示来源标签与固定颜色。
 *
 * 只用于一次性提示（由 pi-extensions-i18n 的提示块渲染）：那种块夹在成排的消息里，
 * 需要 `[xxx]` 标明是谁发的。折叠头不加前缀 —— 它每轮都在、位置固定，前缀只是噪音。
 */

import { NOTICE_TAG_COLOR, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的短标签，同时用作提示来源的 tag。 */
export const NOTICE_TAG = "clean";

/**
 * 提示标签颜色。
 *
 * 所有扩展统一用 `NOTICE_TAG_COLOR`：9 个色槽分给 16 个包必然撞车，一旦撞车颜色就不再
 * 有任何定位价值，反而让人以为两个包是同一条消息。来源靠 `[tag]` 文本区分，
 * 级别靠正文颜色区分。
 */
export const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;

/** 本扩展的提示来源。 */
export const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
