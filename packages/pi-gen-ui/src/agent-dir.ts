import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve Pi's agent directory.
 *
 * Honors `PI_CODING_AGENT_DIR`, matching Pi's own resolution so packages do not
 * hard-code a machine-specific location.
 */
export function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

/** Directory this package owns inside the agent directory. */
export function packageDataDir(): string {
  return join(resolveAgentDir(), "extensions", "pi-gen-ui");
}

/** Path of the persisted configuration file. */
export function configPath(): string {
  return join(packageDataDir(), "config.json");
}

/** Path of the generated component reference the model reads on demand. */
export function catalogDocPath(): string {
  return join(packageDataDir(), "catalog.md");
}
