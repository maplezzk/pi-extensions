import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
  createArgvNotificationAdapter,
  type NotificationAdapter,
  type NotificationFailure,
  type NotificationPayload,
} from "./adapter.ts";
import { loadConfigWithDiagnostics, type NotificationConfig } from "./config.ts";
import { i18n } from "./i18n.ts";

export type { NotificationConfig } from "./config.ts";
export type {
  CommandAvailability,
  NotificationAdapter,
  NotificationAdapterConfig,
  NotificationAdapterOptions,
  NotificationFailure,
  NotificationFailureKind,
  NotificationPayload,
  RunArgvCommand,
} from "./adapter.ts";
export {
  createArgvNotificationAdapter,
  isCommandAvailable,
  renderNotificationArgs,
  runArgvCommand,
} from "./adapter.ts";
export { configPath, loadConfig, loadConfigWithDiagnostics } from "./config.ts";

interface Notice {
  level: "warning";
  message: string;
}

interface NotificationRuntime {
  config: NotificationConfig;
  adapter: NotificationAdapter | null;
  failureReported: boolean;
  context?: ExtensionContext;
}

const pendingNotices: Notice[] = [];
let activeRuntime: NotificationRuntime | undefined;
let noticeKeys = new Set<string>();

/** 导出给其他扩展使用；通知发送在后台执行，不阻塞当前 Pi 事件。 */
export function notify(title: string, subtitle: string, message: string): void {
  const runtime = activeRuntime ?? createRuntime();
  activeRuntime = runtime;
  dispatchNotification(runtime, { title, subtitle, message });
}

export default function piNotifications(pi: ExtensionAPI): void {
  const runtime = createRuntime();
  let turnCount = 0;
  let taskStartTime = 0;
  activeRuntime = runtime;

  pi.on("session_start", (_event, ctx) => {
    runtime.context = ctx;
    flushPendingNotices(ctx);
  });

  pi.on("session_shutdown", () => {
    runtime.context = undefined;
    if (activeRuntime === runtime) activeRuntime = undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    runtime.context = ctx;
    if (event.toolName !== "ask_user_question" && event.toolName !== "ask_user") return;

    const project = basename(ctx.cwd);
    const input = isRecord(event.input) ? event.input : {};
    let prompt = i18n.t("inputNeeded");

    if (event.toolName === "ask_user_question" && Array.isArray(input.questions)) {
      const firstQuestion = isRecord(input.questions[0]) ? input.questions[0] : {};
      const header = asString(firstQuestion.header);
      const question = asString(firstQuestion.question);
      const count = input.questions.length;
      prompt = count > 1
        ? i18n.t("multipleQuestions", {
            prefix: header ? `[${header}] ` : "",
            question,
            count,
          })
        : `${header ? `[${header}] ` : ""}${question}`;
    } else if (event.toolName === "ask_user") {
      prompt = asString(input.question) || i18n.t("inputNeeded");
    }

    dispatchNotification(runtime, {
      title: i18n.t("inputTitle", { project }),
      subtitle: i18n.t("inputNeeded"),
      message: prompt,
    }, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    runtime.context = ctx;
    turnCount = 0;
    taskStartTime = Date.now();
  });

  pi.on("turn_end", async (_event, ctx) => {
    runtime.context = ctx;
    turnCount++;
  });

  pi.on("agent_end", async (event, ctx) => {
    runtime.context = ctx;
    const elapsed = taskStartTime
      ? ((Date.now() - taskStartTime) / 1000).toFixed(1)
      : "?";
    const hasError = event.messages?.some(
      (message: any) => message.role === "tool" && message.isError,
    );
    const project = basename(ctx.cwd);
    const message = turnCount > 0
      ? i18n.t("stepCount", {
          count: turnCount,
          seconds: elapsed,
        })
      : i18n.t("elapsed", { seconds: elapsed });

    dispatchNotification(runtime, {
      title: i18n.t("taskTitle", { project }),
      subtitle: hasError ? i18n.t("taskError") : i18n.t("taskDone"),
      message,
    }, ctx);
  });
}

function createRuntime(): NotificationRuntime {
  const loaded = loadConfigWithDiagnostics();
  const runtime: NotificationRuntime = {
    config: loaded.config,
    adapter: loaded.config.enabled
      ? createArgvNotificationAdapter(
          loaded.config.adapter,
          loaded.config.timeoutMs,
        )
      : null,
    failureReported: false,
  };

  if (loaded.diagnostic) {
    queueNotice(
      "config",
      i18n.t("configInvalid", {
        path: loaded.diagnostic.path,
        reason: loaded.diagnostic.reason,
      }),
    );
  }
  return runtime;
}

function dispatchNotification(
  runtime: NotificationRuntime,
  payload: NotificationPayload,
  context?: ExtensionContext,
): void {
  if (!runtime.adapter) return;

  void runtime.adapter.send(payload).catch((error: unknown) => {
    reportAdapterFailure(runtime, error, context ?? runtime.context);
  });
}

function reportAdapterFailure(
  runtime: NotificationRuntime,
  error: unknown,
  context?: ExtensionContext,
): void {
  if (runtime.failureReported) return;
  runtime.failureReported = true;

  const failure = asNotificationFailure(error);
  const message = failure?.kind === "missing"
    ? i18n.t("adapterMissing", { command: failure.command })
    : i18n.t("sendFailed", {
        command: failure?.command ?? runtime.config.adapter.command,
        reason: failure?.reason ?? errorMessage(error),
      });
  showNotice({ level: "warning", message }, context);
}

function asNotificationFailure(error: unknown): NotificationFailure | undefined {
  if (!isRecord(error)) return undefined;
  if (
    (error.kind === "missing" || error.kind === "failed") &&
    typeof error.command === "string" &&
    typeof error.reason === "string"
  ) {
    return {
      kind: error.kind,
      command: error.command,
      reason: error.reason,
    };
  }
  return undefined;
}

function showNotice(notice: Notice, context?: ExtensionContext): void {
  const key = `${notice.level}:${notice.message}`;
  if (noticeKeys.has(key)) return;
  noticeKeys.add(key);

  if (context?.ui) {
    context.ui.notify(notice.message, notice.level);
  } else {
    pendingNotices.push(notice);
  }
}

function queueNotice(key: string, message: string): void {
  if (noticeKeys.has(key)) return;
  noticeKeys.add(key);
  pendingNotices.push({ level: "warning", message });
}

function flushPendingNotices(context: ExtensionContext): void {
  for (const notice of pendingNotices.splice(0)) {
    context.ui.notify(notice.message, notice.level);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
