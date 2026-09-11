/**
 * 自动催促消息渲染。
 *
 * 默认使用内置的严厉用户语气模板；配置了自定义模板时优先使用，并保证判定理由一定出现。
 */
import { i18n } from "./i18n.ts";

/** 自定义模板里用于插入判定理由的占位符。 */
export const REASON_PLACEHOLDER = "{reason}";

/** 渲染自动催促消息所需参数。 */
export interface ContinueMessageRequest {
  /** 判定模型给出的缺口说明，可能为空字符串。 */
  reason: string;
  /** 用户自定义模板；空字符串表示使用内置模板。 */
  template?: string;
}

/**
 * 把判定理由渲染成自动催促消息。
 * 自定义模板缺少 {reason} 占位时，把理由追加到末尾，避免丢失「还差什么」的信息。
 */
export function renderContinueMessage({ reason, template = "" }: ContinueMessageRequest): string {
  const detail = reason.trim() || i18n.t("continueMessageNoReason");
  if (!template.trim()) return i18n.t("continueMessageDefault", { reason: detail });
  if (template.includes(REASON_PLACEHOLDER)) {
    return template.split(REASON_PLACEHOLDER).join(detail);
  }
  return `${template.trimEnd()}\n\n${i18n.t("continueMessageReasonAppendix", { reason: detail })}`;
}
