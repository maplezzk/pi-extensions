/**
 * 本扩展在会话区里的身份：提示来源标签、固定颜色，以及自绘块的 `[xxx]` 前缀。
 *
 * 会话区里的扩展提示块统一用 `[xxx]` 前缀标注来源（由 pi-extensions-i18n 的提示块渲染）。
 * 压缩快照是 session_squash 自己画的消息块，行首也带同一个前缀，用户在成排的块里
 * 一眼就能认出哪一块是它画的。标签只此一处定义：提示来源和自绘块前缀共用，避免两处漂移。
 *
 * 单独成模块而不是放在 session-tail-compaction.ts：那个文件要从压缩消息渲染器
 * 引入注册函数，渲染器再反过来引它就成环了。
 */

import { NOTICE_TAG_COLOR, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的短标签，同时用作提示来源的 tag。 */
export const NOTICE_TAG = "session";

/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
export const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;

/** 本扩展的提示来源。 */
export const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

/**
 * 自绘块行首的 `[xxx]` 前缀。
 *
 * 与其它包保持一致：标签只是来源标记，不进文案目录，也不随语言变化。
 */
export const PREFIX_TAG = `[${NOTICE_TAG}]`;
