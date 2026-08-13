/**
 * Bash 管道输出保留插件
 *
 * 解决 AI 用 grep/tail/head 过滤输出后丢失完整信息的问题：
 * 当命令包含 `| grep`、`| tail`、`| head` 时，自动在管道中插入 tee，
 * 将过滤前的完整输出保存到临时文件。
 *
 * 效果：
 * - AI 照常拿到 grep/tail/head 过滤后的结果
 * - 完整输出自动存到 /tmp/pi-pipe-cache/xxx.txt
 * - 如果 grep pattern 不对，直接对缓存文件重新 grep，不用重跑命令
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { i18n } from "./i18n.ts";

// ── 配置 ──

/** 缓存目录：系统临时目录下的 pi-pipe-cache（跨平台，不绑定本机）。 */
const CACHE_DIR = join(tmpdir(), "pi-pipe-cache");

/** 自增计数器，保证文件名唯一且有序 */
let counter = 0;

/** bash 工具输入：command 字段在运行时才可靠，统一经 unknown 收窄。 */
type BashToolInput = { command?: unknown };

/** 确保缓存目录存在；不存在时递归创建，幂等。 */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * 匹配管道中第一个 grep/tail/head 的位置。
 * 返回 `|` 的索引，用于插入 tee。
 * 只匹配管道形式（`| grep`），不匹配直接 `grep file` 的情况。
 */
function findFirstFilterPipe(command: string): number | null {
  // 匹配 | 后面跟 grep/tail/head（允许前后空格）
  const match = command.match(/\|\s*(?:grep|tail|head)\b/);
  if (!match || match.index === undefined) return null;
  return match.index;
}

// ── 状态：toolCallId → 缓存文件路径 ──

const pendingCache = new Map<string, string>();

// ── 插件主体 ──

export default function (pi: ExtensionAPI) {
  // ── tool_call: 改写命令，插入 tee ──
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;

    const input = (event.input ?? {}) as BashToolInput;
    const command = typeof input.command === "string" ? input.command : "";
    if (!command.trim()) return;

    const pipeIndex = findFirstFilterPipe(command);
    if (pipeIndex === null) return;

    ensureCacheDir();
    counter++;
    const fileName = `${counter}.txt`;
    const filePath = join(CACHE_DIR, fileName);

    // 在第一个 filter 管道符前插入 tee
    // 原: cmd | grep "pat"
    // 改: cmd | tee /tmp/pi-pipe-cache/1.txt | grep "pat"
    const before = command.slice(0, pipeIndex);
    const after = command.slice(pipeIndex); // 包含 `| grep...`
    (input as { command: string }).command = `${before}| tee ${filePath} ${after}`;

    pendingCache.set(event.toolCallId, filePath);
  });

  // ── tool_result: 追加缓存路径提示 ──
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;

    const filePath = pendingCache.get(event.toolCallId);
    if (!filePath) return;
    pendingCache.delete(event.toolCallId);

    const hint = i18n.t("cacheHint", { path: filePath });

    const newContent = [...event.content];
    let lastTextIndex = -1;
    for (let index = newContent.length - 1; index >= 0; index--) {
      if (newContent[index]?.type === "text") {
        lastTextIndex = index;
        break;
      }
    }
    if (lastTextIndex >= 0) {
      const block = newContent[lastTextIndex] as { type: "text"; text: string };
      newContent[lastTextIndex] = {
        ...block,
        text: (block.text ?? "") + hint,
      };
    } else {
      newContent.push({ type: "text", text: hint });
    }

    return { content: newContent };
  });
}
