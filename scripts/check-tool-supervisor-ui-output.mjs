#!/usr/bin/env node
/**
 * Ensures pi-tool-supervisor reports runtime failures through Pi UI notifications.
 * Runtime extension code must not write warnings or errors directly to the terminal.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SUPERVISOR_DIR = resolve(ROOT, "packages/pi-tool-supervisor");
const CONSOLE_OUTPUT = /\bconsole\.(?:warn|error)\s*\(/g;
const violations = [];

/** Recursively collects JavaScript and TypeScript source files under a package. */
function collectSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

for (const path of collectSourceFiles(SUPERVISOR_DIR)) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (CONSOLE_OUTPUT.test(line)) {
      violations.push(`${relative(ROOT, path)}:${index + 1}: ${line.trim()}`);
    }
    CONSOLE_OUTPUT.lastIndex = 0;
  });
}

if (violations.length > 0) {
  process.stdout.write([
    "pi-tool-supervisor 禁止直接使用 console.warn/console.error，请改用 ctx.ui.notify：",
    ...violations,
    "",
  ].join("\n"));
  process.exitCode = 1;
} else {
  process.stdout.write("pi-tool-supervisor UI 输出门禁通过。\n");
}
