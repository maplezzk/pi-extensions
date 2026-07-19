#!/usr/bin/env node
/**
 * 本机解耦门禁（AGENTS.md《本机解耦约定》的 CI 执行版）
 *
 * 检查项（origin §7）：
 * 1. packages 下各包的 src、tests、index.ts 中不得出现 /Users/ 绝对路径
 * 2. packages/ 下不得出现私有域名/业务名（shopcider、plutus、harbor.、gitlab.）
 * 3. 三包 locales/*.json 中英文案 key 集合必须一致
 *
 * 任一命中即退出码 1，并输出文件与行号。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let failed = false;

// packages/ 可能尚未填充（空骨架阶段）：不存在则创建，保证 grep 有稳定目标
const PACKAGES_DIR = join(ROOT, "packages");
if (!existsSync(PACKAGES_DIR)) mkdirSync(PACKAGES_DIR);

function grepCheck(label, pattern, targets) {
  try {
    const out = execFileSync(
      "grep",
      ["-rnEi", pattern, ...targets],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (out.trim()) {
      failed = true;
      console.error(`❌ [${label}] 命中 ${pattern}：\n${out.trim()}`);
    } else {
      console.log(`✅ [${label}] 无命中`);
    }
  } catch (e) {
    // grep 退出码 1 = 无命中；>1 = 错误
    if (e.status === 1) {
      console.log(`✅ [${label}] 无命中`);
    } else {
      failed = true;
      console.error(`❌ [${label}] grep 执行失败：${e.message}`);
    }
  }
}

// 1. 本机绝对路径
grepCheck("no-local-path", "/Users/", [
  "packages",
]);

// 2. 私有域名/业务名
grepCheck("no-private-domain", "shopcider|plutus|harbor\\.|gitlab\\.", [
  "packages",
]);

// 3. i18n 双语 key 对齐：同一 locale 文件中每个 key 必须同时含 zh-CN 与 en-US
function checkI18nKeys() {
  const packagesDir = join(ROOT, "packages");
  if (!existsSync(packagesDir)) return;
  for (const pkg of readdirSync(packagesDir)) {
    const localesDir = join(packagesDir, pkg, "locales");
    if (!existsSync(localesDir)) continue;
    for (const file of readdirSync(localesDir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(localesDir, file);
      let catalog;
      try {
        catalog = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        failed = true;
        console.error(`❌ [i18n-keys] ${pkg}/locales/${file} JSON 解析失败：${e.message}`);
        continue;
      }
      for (const [key, value] of Object.entries(catalog)) {
        if (value == null || typeof value !== "object") continue;
        const missing = ["zh-CN", "en-US"].filter((lang) => !(lang in value));
        if (missing.length > 0) {
          failed = true;
          console.error(
            `❌ [i18n-keys] ${pkg}/locales/${file} key "${key}" 缺少语言: ${missing.join(", ")}`,
          );
        }
      }
    }
  }
  if (!failed) console.log("✅ [i18n-keys] 中英文 key 对齐");
}
checkI18nKeys();

if (failed) {
  console.error("\n本机解耦门禁未通过，请修正上述命中项。");
  process.exit(1);
}
console.log("\n本机解耦门禁通过。");
