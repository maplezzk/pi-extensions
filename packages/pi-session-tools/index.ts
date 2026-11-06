import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installNoticeRenderer } from "pi-extensions-i18n";
import bashOutputCache from "./src/bash-output-cache.ts";
import sessionTailCompaction from "./src/session-tail-compaction.ts";

export default function piSessionTools(pi: ExtensionAPI): void {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  bashOutputCache(pi);
  sessionTailCompaction(pi);
}

export { default as bashOutputCache } from "./src/bash-output-cache.ts";
export { default as sessionTailCompaction } from "./src/session-tail-compaction.ts";
