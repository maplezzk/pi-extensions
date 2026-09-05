import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type NamingConfig } from "./config.ts";
import { i18n } from "./i18n.ts";
import { registerAutomaticSessionNaming, type SessionNameRequester } from "./session-name.ts";

const CONFIG_WARNING = "warning";

/** 按配置组合命名功能；只使用自动命名时不加载终端模块。 */
export async function registerNaming(
  pi: ExtensionAPI,
  config: NamingConfig,
  requestName?: SessionNameRequester,
): Promise<void> {
  if (config.workspaceRename || config.tabRename) {
    const { registerTerminalRename } = await import("./terminal-rename.ts");
    registerTerminalRename(pi, requestName, undefined, config);
  }
  registerAutomaticSessionNaming(pi, requestName, config.automaticNaming);
}

/** 将配置读取结果与后续通知、注册动作分离。 */
function readConfig(): { config: NamingConfig } | { error: unknown } {
  try {
    return { config: loadConfig() };
  } catch (error) {
    return { error };
  }
}

/** 配置错误明确通知；模块加载错误保留给 Pi 报告。 */
export default async function namingExtension(pi: ExtensionAPI): Promise<void> {
  const result = readConfig();
  if ("error" in result) {
    const message = i18n.t("namingConfigFailed", {
      error: result.error instanceof Error ? result.error.message : String(result.error),
    });
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(message, CONFIG_WARNING));
    return;
  }
  await registerNaming(pi, result.config);
}
