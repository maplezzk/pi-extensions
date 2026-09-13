/**
 * 本扩展统一的提示来源定义。
 * 所有 notifyWithSource 调用共用同一份标签与颜色，避免两个入口不一致。
 */

import type { NoticeColor, NoticeSource } from "pi-extensions-i18n";

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
export const NOTICE_TAG = "metrics";
/** 提示标签颜色；与其它扩展错开，避免看起来像同一条消息。 */
export const NOTICE_COLOR: NoticeColor = "dim";
/** 本扩展的提示来源。 */
export const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
