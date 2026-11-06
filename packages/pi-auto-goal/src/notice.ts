/**
 * 本扩展统一的提示来源定义。
 * 所有 notifyWithSource 调用共用同一份标签与颜色，避免多个入口各写一套。
 */

import { NOTICE_TAG_COLOR, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
export const NOTICE_TAG = "auto-goal";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
export const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
export const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
