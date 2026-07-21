import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import turnElapsed from "./turn-elapsed.ts";

export default function piHud(pi: ExtensionAPI): void {
  // 后续 HUD 类功能（如 token 用量、上下文水位等）在此注册
  turnElapsed(pi);
}

export { default as turnElapsed } from "./turn-elapsed.ts";
export * from "./format-utils.ts";
