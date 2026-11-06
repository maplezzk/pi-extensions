import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 打开调试日志的环境变量。 */
const DEBUG_ENV = "PI_CLEAN_MODE_DEBUG";
/** 日志文件名，写在 Pi agent 目录下。 */
const LOG_FILE_NAME = "pi-clean-mode-debug.log";

/** 是否启用调试日志；进程启动时读一次，避免在渲染热路径上反复读环境变量。 */
const DEBUG_ENABLED = process.env[DEBUG_ENV] === "1";

/** 是否启用调试日志。 */
function isEnabled(): boolean {
	return DEBUG_ENABLED;
}

/** 返回调试日志路径。 */
export function debugLogPath(): string {
	return join(getAgentDir(), LOG_FILE_NAME);
}

/**
 * 追加一条调试日志。
 *
 * 仅当设置了 `PI_CLEAN_MODE_DEBUG=1` 时写盘；写入失败静默忽略，
 * 调试设施不能影响主流程。
 */
export function debugLog(scope: string, message: string): void {
	if (!isEnabled()) {
		return;
	}
	try {
		appendFileSync(debugLogPath(), `${Date.now()} [${scope}] ${message}\n`, "utf8");
	} catch {
		// 调试日志失败不影响功能。
	}
}
