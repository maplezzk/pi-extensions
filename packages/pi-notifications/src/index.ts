import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
  createArgvNotificationAdapter,
  type NotificationAdapter,
  type NotificationFailure,
  type NotificationPayload,
} from "./adapter.ts";
import { loadConfigWithDiagnostics, parseConfig, saveConfig, type NotificationConfig } from "./config.ts";
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
export { configPath, loadConfig, loadConfigWithDiagnostics, parseConfig, saveConfig } from "./config.ts";

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

const CONFIG_COMMAND_ALIASES = ["config:notifications", "notifications-config", "pi-notifications-config"] as const;
const CONFIG_RESET_COMMAND = "reset";
const CONFIG_OPTION = { enabled: 0, command: 1, args: 2, timeout: 3 } as const;
const CONFIG_ARG_SEPARATOR = ",";
const CONFIG_ARG_DISPLAY_SEPARATOR = ", ";
const COMMAND_PRESETS = ["terminal-notifier", "notify-send"] as const;
const TIMEOUT_PRESETS = ["1000", "3000", "5000"] as const;
const NOTICE_WARNING = "warning" as const;
const NOTICE_INFO = "info" as const;
const NOTICE_ERROR = "error" as const;

const pendingNotices: Notice[] = [];
let activeRuntime: NotificationRuntime | undefined;
let noticeKeys = new Set<string>();

/** 注册配置命令，通过 TUI 菜单和输入框修改通知配置。 */
function registerConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    getArgumentCompletions: () => [{ value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND }],
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const argument = args.trim();
      if (argument && argument !== CONFIG_RESET_COMMAND) {
        ctx.ui.notify(i18n.t("configCommandUsage"), NOTICE_WARNING);
        return;
      }
      if (argument === CONFIG_RESET_COMMAND) {
        try {
          const path = saveConfig(parseConfig({}));
          ctx.ui.notify(i18n.t("configCommandSaved", { path }), NOTICE_INFO);
        } catch (error) {
          ctx.ui.notify(i18n.t("configCommandInvalid", {
            error: error instanceof Error ? error.message : String(error),
          }), NOTICE_ERROR);
        }
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("configCommandInteractiveOnly"), NOTICE_WARNING);
        return;
      }

      let config: NotificationConfig;
      try {
        config = loadConfigWithDiagnostics().config;
      } catch (error) {
        ctx.ui.notify(i18n.t("configCommandInvalid", {
          error: error instanceof Error ? error.message : String(error),
        }), NOTICE_ERROR);
        return;
      }
      const save = (next: NotificationConfig): void => {
        try {
          const path = saveConfig(next);
          config = next;
          ctx.ui.notify(i18n.t("configCommandSaved", { path }), NOTICE_INFO);
        } catch (error) {
          ctx.ui.notify(i18n.t("configCommandInvalid", {
            error: error instanceof Error ? error.message : String(error),
          }), NOTICE_ERROR);
        }
      };
      const status = (enabled: boolean): string => enabled ? i18n.t("configOn") : i18n.t("configOff");

      /** Selects a common scalar value and only opens text input for custom values. */
      const chooseSettingValue = async (
        title: string,
        current: string,
        options: readonly string[],
      ): Promise<string | undefined> => {
        const customChoice = i18n.t("configCustom");
        const cancelChoice = i18n.t("configCancel");
        const choices = [
          ...options.map((value) => i18n.t("configPresetValue", { value })),
          customChoice,
          cancelChoice,
        ];
        const selected = await ctx.ui.select(title, choices);
        if (selected === undefined || selected === cancelChoice) return undefined;
        if (selected === customChoice) return ctx.ui.input(title, current);
        const index = choices.indexOf(selected);
        return index >= 0 && index < options.length ? options[index] : undefined;
      };

      while (true) {
        const doneChoice = i18n.t("configDone");
        const choices = [
          i18n.t("configEnabled", { value: status(config.enabled) }),
          i18n.t("configCommand", { value: config.adapter.command }),
          i18n.t("configArguments", { value: config.adapter.args.join(CONFIG_ARG_DISPLAY_SEPARATOR) }),
          i18n.t("configTimeout", { value: config.timeoutMs }),
          doneChoice,
        ];
        const selected = await ctx.ui.select(i18n.t("configMenuTitle"), choices);
        if (selected === undefined || selected === doneChoice) return;
        const selectedIndex = choices.indexOf(selected);
        let next: NotificationConfig | undefined;
        if (selectedIndex === CONFIG_OPTION.enabled) {
          next = parseConfig({ ...config, enabled: !config.enabled });
        } else {
          let title = i18n.t("configTimeoutInput");
          let current = String(config.timeoutMs);
          let options: readonly string[] = TIMEOUT_PRESETS;
          if (selectedIndex === CONFIG_OPTION.command) {
            title = i18n.t("configCommandInput");
            current = config.adapter.command;
            options = COMMAND_PRESETS;
          } else if (selectedIndex === CONFIG_OPTION.args) {
            title = i18n.t("configArgumentsInput");
            current = config.adapter.args.join(CONFIG_ARG_DISPLAY_SEPARATOR);
            options = [config.adapter.args.join(CONFIG_ARG_DISPLAY_SEPARATOR)];
          }
          const input = await chooseSettingValue(title, current, options);
          if (input === undefined) continue;
          const adapter = { ...config.adapter };
          if (selectedIndex === CONFIG_OPTION.command) adapter.command = input.trim();
          else if (selectedIndex === CONFIG_OPTION.args) {
            adapter.args = input.split(CONFIG_ARG_SEPARATOR).map((arg) => arg.trim()).filter(Boolean);
          }
          else {
            const timeoutMs = Number(input.trim());
            try { next = parseConfig({ ...config, timeoutMs }); }
            catch (error) {
              ctx.ui.notify(i18n.t("configCommandInvalid", {
                error: error instanceof Error ? error.message : String(error),
              }), NOTICE_ERROR);
            }
          }
          if (selectedIndex === CONFIG_OPTION.command || selectedIndex === CONFIG_OPTION.args) {
            try { next = parseConfig({ ...config, adapter }); }
            catch (error) {
              ctx.ui.notify(i18n.t("configCommandInvalid", {
                error: error instanceof Error ? error.message : String(error),
              }), NOTICE_ERROR);
            }
          }
        }
        if (next) save(next);
      }
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 导出给其他扩展使用；通知发送在后台执行，不阻塞当前 Pi 事件。 */
export function notify(title: string, subtitle: string, message: string): void {
  const runtime = activeRuntime ?? createRuntime();
  activeRuntime = runtime;
  dispatchNotification(runtime, { title, subtitle, message });
}

export default function piNotifications(pi: ExtensionAPI): void {
  registerConfigCommand(pi);
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
