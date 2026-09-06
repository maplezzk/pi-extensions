import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NotificationAdapterConfig } from "./adapter.ts";

export interface NotificationConfig {
  enabled: boolean;
  adapter: NotificationAdapterConfig;
  timeoutMs: number;
}

export interface ConfigDiagnostic {
  path: string;
  reason: string;
}

export interface LoadedNotificationConfig {
  config: NotificationConfig;
  diagnostic?: ConfigDiagnostic;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  adapter: {
    command: "terminal-notifier",
    args: [
      "-title",
      "{title}",
      "-subtitle",
      "{subtitle}",
      "-message",
      "{message}",
      "-sound",
      "default",
      "-timeout",
      "5",
    ],
  },
  timeoutMs: 3000,
};

const CONFIG_FILE_NAME = "config.json";
const CONFIG_DIRECTORY_NAME = "pi-notifications";

/** 返回当前 Pi agent 目录下的通知配置路径。 */
export function configPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

/** 读取通知配置；文件缺失时使用默认配置。 */
export function loadConfig(): NotificationConfig {
  return loadConfigWithDiagnostics().config;
}

/** 读取通知配置，并保留损坏配置的诊断信息供 UI 一次提示。 */
export function loadConfigWithDiagnostics(): LoadedNotificationConfig {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { config: cloneDefaultConfig() };
    return {
      config: cloneDefaultConfig(),
      diagnostic: { path, reason: errorMessage(error) },
    };
  }

  try {
    return { config: parseConfig(JSON.parse(raw)) };
  } catch (error) {
    return {
      config: cloneDefaultConfig(),
      diagnostic: { path, reason: errorMessage(error) },
    };
  }
}

function parseConfig(value: unknown): NotificationConfig {
  if (!isRecord(value)) throw new Error("configuration must be a JSON object");

  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");

  const adapterValue = value.adapter === undefined
    ? DEFAULT_NOTIFICATION_CONFIG.adapter
    : value.adapter;
  if (!isRecord(adapterValue)) throw new Error("adapter must be an object");

  const command = adapterValue.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("adapter.command must be a non-empty string");
  }

  const args = adapterValue.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("adapter.args must be an array of strings");
  }

  const timeoutMs = value.timeoutMs === undefined
    ? DEFAULT_NOTIFICATION_CONFIG.timeoutMs
    : value.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("timeoutMs must be a positive integer");
  }

  return {
    enabled,
    adapter: { command: command.trim(), args: [...args] },
    timeoutMs,
  };
}

function cloneDefaultConfig(): NotificationConfig {
  return {
    enabled: DEFAULT_NOTIFICATION_CONFIG.enabled,
    adapter: {
      command: DEFAULT_NOTIFICATION_CONFIG.adapter.command,
      args: [...DEFAULT_NOTIFICATION_CONFIG.adapter.args],
    },
    timeoutMs: DEFAULT_NOTIFICATION_CONFIG.timeoutMs,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
