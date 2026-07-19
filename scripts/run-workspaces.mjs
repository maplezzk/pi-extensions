#!/usr/bin/env node
/**
 * workspace 脚本容错运行器
 *
 * 空骨架阶段（packages/ 下尚无任何含 package.json 的包）时，
 * `npm run <script> --workspaces` 会以 "No workspaces found!" 报错退出。
 * 此时跳过是合法行为；一旦有包就位则正常聚合执行。
 *
 * 用法：node scripts/run-workspaces.mjs <npm-script-name>
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const script = process.argv[2];
if (!script) {
  console.error("用法: node scripts/run-workspaces.mjs <npm-script-name>");
  process.exit(2);
}

const packagesDir = new URL("../packages", import.meta.url).pathname;
const hasWorkspace =
  existsSync(packagesDir) &&
  readdirSync(packagesDir).some((d) =>
    existsSync(join(packagesDir, d, "package.json")),
  );

if (!hasWorkspace) {
  console.log(`（空骨架：packages/ 下无 workspace，跳过 npm ${script}）`);
  process.exit(0);
}

execFileSync("npm", ["run", script, "--workspaces", "--if-present"], {
  stdio: "inherit",
});
