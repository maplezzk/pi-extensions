import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  addedDirectoryPathsFromBranch,
  findOutOfScopeBashPaths,
} from "./bash-directory-scope-utils";
import { i18n, SHELL_PARSE_BLOCKED_MESSAGE_KEY } from "./i18n";
import { analyzeShellCommand } from "./shell-command-utils";

/** 注册 Bash 目录范围拦截器，放行工作目录、已加入目录、skills 与临时系统目录。 */
export default function bashDirectoryScope(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    if (analyzeShellCommand(command).errors.length > 0) {
      return { block: true, reason: i18n.t(SHELL_PARSE_BLOCKED_MESSAGE_KEY) };
    }

    const addedDirectories = addedDirectoryPathsFromBranch(ctx.sessionManager.getBranch());
    const violations = findOutOfScopeBashPaths(command, ctx.cwd, addedDirectories);
    if (violations.length === 0) return;

    return { block: true, reason: i18n.t("bashScopeBlocked") };
  });
}
