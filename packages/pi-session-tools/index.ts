import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashOutputCache from "./src/bash-output-cache.ts";
import sessionTailCompaction from "./src/session-tail-compaction.ts";

export default function piSessionTools(pi: ExtensionAPI): void {
  bashOutputCache(pi);
  sessionTailCompaction(pi);
}

export { default as bashOutputCache } from "./src/bash-output-cache.ts";
export { default as sessionTailCompaction } from "./src/session-tail-compaction.ts";
