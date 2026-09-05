/**
 * Pi Maven 命令禁用插件
 *
 * 行为：
 * - 不允许直接调用任何 Maven 命令，包括 `mvn verify`。
 * - 其他 bash 中的 Maven 调用都会被直接阻断。
 * - 编译、测试、构建、启动等 Java 项目操作提示 agent 改用指定 skill（默认 java-build）。
 *
 * 为什么这样做：Java / Maven 项目验证统一复用 IDE 的编译缓存与配置，避免 agent 直接执行 mvn 造成慢、日志污染和环境不一致。
 *
 * 解耦：提示使用的 skill 名通过配置读取（src/config.ts），改 skill 只需改
 * `~/.pi/agent/extensions/pi-safety-guards/config.json` 的 javaSkill 字段，不动代码或文案。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { i18n, SHELL_PARSE_BLOCKED_MESSAGE_KEY } from "./i18n";
import { loadConfig } from "./config";
import { containsMavenCommand } from "./mvn-enforce-flags-utils";
import { analyzeShellCommand } from "./shell-command-utils";

/** 注册 Maven 命令拦截器，阻断后提示使用配置指定的 skill。 */
export default function (pi: ExtensionAPI, javaSkill = loadConfig().javaSkill) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    if (analyzeShellCommand(command).errors.length > 0) {
      return { block: true, reason: i18n.t(SHELL_PARSE_BLOCKED_MESSAGE_KEY) };
    }
    if (!containsMavenCommand(command)) return;

    // 配置在注册时确定；修改开关或 skill 后通过 reload 生效。
    const reason = i18n.t("mavenBlocked", { skill: javaSkill });
    return {
      block: true,
      reason,
    };
  });
}
