import type { SafetyRule } from "./types.ts";

/** 预设只保存规则数据，检测器不决定动作或替代工具。 */
export const PRESETS: Readonly<Record<string, readonly SafetyRule[]>> = {
  "destructive-operations": [
    { id: "filesystem.delete", action: "confirm", match: { commands: ["rm", "rmdir"] } },
    { id: "filesystem.format", action: "confirm", match: { detector: "disk-format" } },
    { id: "filesystem.ownership", action: "confirm", match: { commands: ["chown"] } },
    { id: "shell.fork-bomb", action: "confirm", match: { detector: "fork-bomb" } },
  ],
  "workspace-boundary": [
    { id: "paths.workspace", action: "block", match: { outsideRoots: ["."] } },
  ],
};

export const DEFAULT_PRESETS = ["destructive-operations"] as const;
