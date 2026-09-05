/**
 * Pi 危险命令确认插件
 *
 * 拦截 bash 工具中的危险操作：
 * - sed：直接阻断，提示用 edit 工具替代
 * - rm、rmdir：直接阻断，提示用 trash 替代
 * - chown、mkfs、fork bomb：弹出确认框
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findDangerRule } from "./danger-utils";
import { i18n, localizeDangerLabel, SHELL_PARSE_BLOCKED_MESSAGE_KEY } from "./i18n";
import { analyzeShellCommand } from "./shell-command-utils";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    if (analyzeShellCommand(command).errors.length > 0) {
      return { block: true, reason: i18n.t(SHELL_PARSE_BLOCKED_MESSAGE_KEY) };
    }

    const matched = findDangerRule(command);
    if (!matched) return;
    const displayLabel = localizeDangerLabel(matched.label);

    // AST 只会把实际执行的 rm/rmdir 匹配为危险命令，git rm 等子命令天然放行。
    if (matched.label === "rm（删除文件/目录）" || matched.label === "rmdir（删除空目录）") {
      // rm/rmdir：直接阻断，提示用 trash 替代
      return {
        block: true,
        reason: [
          i18n.t("detectedDanger", { label: displayLabel }),
          i18n.t("useTrash"),
          i18n.t("commandText", { command }),
        ].join("\n"),
      };
    }

    // sed -i：直接阻断，不弹确认框，提示用 edit 替代
    if (matched.label === "sed -i（原地修改文件）") {
      return {
        block: true,
        reason: [
          i18n.t("detectedDanger", { label: displayLabel }),
          i18n.t("useEdit"),
        ].join("\n"),
      };
    }

    // 直接搜索 ~ 目录：直接阻断，提示指定具体子目录
    if (matched.label === "直接搜索 ~ 目录") {
      return {
        block: true,
        reason: [
          i18n.t("detectedDanger", { label: displayLabel }),
          i18n.t("broadHome"),
          i18n.t("exampleHome"),
          i18n.t("commandText", { command }),
        ].join("\n"),
      };
    }

    // find / 全盘搜索：直接阻断，提示指定具体路径
    if (matched.label === "find /（全盘搜索）") {
      return {
        block: true,
        reason: [
          i18n.t("detectedDanger", { label: displayLabel }),
          i18n.t("broadRoot"),
          i18n.t("exampleRoot"),
          i18n.t("commandText", { command }),
        ].join("\n"),
      };
    }

    // 无 UI（print/json 模式）直接阻断
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: [
          i18n.t("detectedDanger", { label: displayLabel }),
          i18n.t("needConfirm"),
          i18n.t("commandText", { command }),
        ].join("\n"),
      };
    }

    // 其他危险命令：直接进入确认弹窗。
    const ok = await ctx.ui.confirm(
      i18n.t("confirmDanger", { label: displayLabel }),
      i18n.t("confirmCommand", { command }),
    );
    if (!ok) {
      return {
        block: true,
        reason: i18n.t("rejected", { label: displayLabel }),
      };
    }
  });
}
