import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface NotificationPayload {
  title: string;
  subtitle: string;
  message: string;
}

export interface NotificationAdapterConfig {
  command: string;
  args: string[];
}

export type NotificationFailureKind = "missing" | "failed";

export interface NotificationFailure {
  kind: NotificationFailureKind;
  command: string;
  reason: string;
}

export type CommandAvailability = (command: string) => boolean;
export type RunArgvCommand = (command: string, args: string[], timeoutMs: number) => Promise<void>;

export interface NotificationAdapterOptions {
  isCommandAvailable?: CommandAvailability;
  run?: RunArgvCommand;
}

export interface NotificationAdapter {
  send(payload: NotificationPayload): Promise<void>;
}

const WINDOWS_DEFAULT_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

/** 把通知内容按 argv 参数模板展开，不经过 shell。 */
export function renderNotificationArgs(
  args: readonly string[],
  payload: NotificationPayload,
): string[] {
  const values: Record<string, string> = {
    title: payload.title,
    subtitle: payload.subtitle,
    message: payload.message,
  };
  return args.map((arg) => arg.replace(/\{(title|subtitle|message)\}/g, (_, key: string) => values[key]));
}

/** 检查命令是否能在当前运行时找到，避免调用 command -v 或其他 shell。 */
export function isCommandAvailable(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return canExecute(trimmed);
  }

  const pathValue = process.env.PATH ?? "";
  const candidates = pathValue.split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? windowsExtensions(trimmed) : [""];
  return candidates.some((directory) => {
    if (!directory) return false;
    return extensions.some((extension) => canExecute(resolve(directory, `${trimmed}${extension}`)));
  });
}

function windowsExtensions(command: string): string[] {
  if (command.includes(".")) return [""];
  const configured = process.env.PATHEXT
    ?.split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : WINDOWS_DEFAULT_EXTENSIONS;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 使用 Node spawn 的 argv 形式执行外部通知命令。 */
export function runArgvCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (error) rejectPromise(error);
      else resolvePromise();
    };

    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      finish(toError(error));
      return;
    }

    timeoutHandle = setTimeout(() => {
      child.kill();
      finish(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => finish(toError(error)));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const status = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      finish(new Error(`command failed with ${status}`));
    });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 创建一次性失效的 argv 通知 adapter。
 * 第一次缺少命令或执行失败后停止后续尝试，由调用方负责展示一次提示。
 */
export function createArgvNotificationAdapter(
  config: NotificationAdapterConfig,
  timeoutMs: number,
  options: NotificationAdapterOptions = {},
): NotificationAdapter {
  const checkCommand = options.isCommandAvailable ?? isCommandAvailable;
  const run = options.run ?? runArgvCommand;
  let disabled = false;
  let commandChecked = false;
  let commandAvailable = false;

  return {
    async send(payload) {
      if (disabled) return;

      if (!commandChecked) {
        commandChecked = true;
        commandAvailable = checkCommand(config.command);
      }
      if (!commandAvailable) {
        disabled = true;
        throw <NotificationFailure>{
          kind: "missing",
          command: config.command,
          reason: "command not found in PATH",
        };
      }

      try {
        await run(config.command, renderNotificationArgs(config.args, payload), timeoutMs);
      } catch (error) {
        disabled = true;
        throw <NotificationFailure>{
          kind: "failed",
          command: config.command,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
