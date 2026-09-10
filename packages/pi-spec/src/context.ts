import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import type { StateFile } from "./state.ts";
import { i18n } from "./i18n.ts";

export const STATUS_CONTEXT = "spec-mode-context";
export const PROCEDURE_CONTEXT = "spec-mode-procedure";
type Messages = ContextEvent["messages"];
const AWAITING_APPROVAL = "awaiting_approval";
const COMPLETE_PHASE = "complete";
const CUSTOM_ROLE = "custom" as const;
const EMPTY_PROCEDURE_ERROR_KEY = "errors.emptyProcedure";

/** 每次按当前阶段读取，资源丢失不能被进程缓存掩盖。 */
export function loadProcedure(state: StateFile, root = new URL("../procedures/", import.meta.url)): string | null {
  if (state.status === AWAITING_APPROVAL || state.phase === COMPLETE_PHASE) return null;
  const translator = createTranslator(loadCatalog(new URL(`${state.phase}.json`, root)));
  const text = translator.t("body");
  if (!text.trim()) throw new Error(i18n.t(EMPTY_PROCEDURE_ERROR_KEY, { phase: state.phase }));
  return text;
}

/** 只处理自己拥有的消息；内容相同保留一份，丢失则补回，不修改会话历史。 */
export function reconcileContext(messages: Messages, status: string | null, procedure: string | null): Messages {
  let retained = false;
  const next = messages.filter((message) => {
    if (message.role !== CUSTOM_ROLE) return true;
    if (message.customType === STATUS_CONTEXT) return false;
    if (message.customType !== PROCEDURE_CONTEXT) return true;
    if (!retained && procedure !== null && message.content === procedure) {
      retained = true;
      return true;
    }
    return false;
  });
  if (procedure !== null && !retained) next.push({
    role: CUSTOM_ROLE, customType: PROCEDURE_CONTEXT, content: procedure, display: false, timestamp: Date.now(),
  });
  if (status !== null) next.push({
    role: CUSTOM_ROLE, customType: STATUS_CONTEXT, content: status, display: false, timestamp: Date.now(),
  });
  return next;
}
