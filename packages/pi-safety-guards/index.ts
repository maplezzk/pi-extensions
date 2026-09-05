import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashDirectoryScope from "./src/bash-directory-scope.ts";
import dangerCommands from "./src/danger-commands.ts";
import mavenEnforceFlags from "./src/mvn-enforce-flags.ts";
import { loadConfig, type SafetyConfig } from "./src/config.ts";
import { i18n } from "./src/i18n.ts";

const CONFIG_ERROR_LEVEL = "error";
const BASH_TOOL = "bash";

/**
 * 注册危险命令、Bash 目录范围和默认 Maven 三组独立安全守卫。
 *
 * 通知适配器不属于本包；需要通知时请单独安装 pi-notifications。
 */
export default function piSafetyGuards(pi: ExtensionAPI): void {
  try {
    registerSafetyGuards(pi, loadConfig());
  } catch (error) {
    const reason = i18n.t("configInvalid", {
      error: error instanceof Error ? error.message : String(error),
    });
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(reason, CONFIG_ERROR_LEVEL));
    // 配置损坏时不能放行 Bash；修复配置并 reload 后恢复正常守卫。
    pi.on("tool_call", (event) => {
      if (event.toolName === BASH_TOOL) return { block: true, reason };
    });
  }
}

/** 仅为启用的安全功能注册 hook，便于独立组合和测试。 */
export function registerSafetyGuards(pi: ExtensionAPI, config: SafetyConfig): void {
  if (config.dangerCommands) dangerCommands(pi);
  if (config.maven) mavenEnforceFlags(pi, config.javaSkill);
  if (config.bashDirectoryScope) bashDirectoryScope(pi);
}

export { default as bashDirectoryScope } from "./src/bash-directory-scope.ts";
export { default as dangerCommands } from "./src/danger-commands.ts";
export { default as mavenEnforceFlags } from "./src/mvn-enforce-flags.ts";
export {
  DANGER_RULES,
  findDangerRule,
} from "./src/danger-utils.ts";
export {
  addedDirectoryPathsFromBranch,
  findOutOfScopeBashPaths,
} from "./src/bash-directory-scope-utils.ts";
export { containsMavenCommand } from "./src/mvn-enforce-flags-utils.ts";
