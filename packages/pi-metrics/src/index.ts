import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import turnElapsed from "./turn-elapsed.ts";
import tps from "./tps.ts";

export default function piHud(pi: ExtensionAPI): void {
  turnElapsed(pi);
  tps(pi);
}

export { default as turnElapsed } from "./turn-elapsed.ts";
export { default as tps } from "./tps.ts";
export * from "./format-utils.ts";
export * from "./tps.ts";
