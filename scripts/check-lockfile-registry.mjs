#!/usr/bin/env node
/**
 * 依赖来源门禁
 *
 * 背景：本机若把 registry 指向镜像，npm 会把镜像地址写进 package-lock.json 的 resolved 字段。
 * npm 12 默认 allow-remote=none，会拒绝拉取与配置 registry 不一致的 tarball，表现为
 * `npm ci` 报 EALLOWREMOTE，Release 工作流在 Install dependencies 阶段整批失败。
 * 这类问题在 Node 22 自带 npm 10 上不会暴露（CI 用 `npm ci`/`npm install` 都能过），
 * 所以必须在提交前静态检查。
 *
 * 检查项：
 * 1. 各 lockfile 的 resolved 只能指向 https://registry.npmjs.org/
 * 2. 各包 package.json 的 publishConfig.registry（若存在）只能是 https://registry.npmjs.org
 *
 * 用法：node scripts/check-lockfile-registry.mjs [--lockfile <path>]
 * 任一命中即退出码 1。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const EXPECTED_REGISTRY = "https://registry.npmjs.org/";
const EXPECTED_HOST = "registry.npmjs.org";
const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** 单次最多逐条打印的违规条目数，避免输出淹没 CI 日志 */
const MAX_REPORTED_OFFENDERS = 20;

const problems = [];

/** 记录一条门禁失败项：立即打印，最后统一决定退出码 */
function report(message) {
  problems.push(message);
  console.error(`❌ ${message}`);
}

/** 解析 JSON 文件；解析失败时记录问题并返回 null */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    report(`${file} 解析失败：${e.message}`);
    return null;
  }
}

/** 取 URL 的 host；非法 URL 返回空串（会被当作违规来源处理） */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 递归收集 lockfile 路径，跳过 node_modules 与 .git */
function findLockfiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findLockfiles(full, acc);
    } else if (LOCKFILE_NAMES.has(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 检查单个 lockfile：所有 http(s) 来源必须指向官方 registry，非 http 来源只提示人工确认 */
function checkLockfile(lockfile) {
  const lock = readJson(lockfile);
  if (lock === null) return;

  const resolvedEntries = Object.entries(lock.packages ?? {})
    // link 条目是 workspace 软链（resolved 为本地目录），不属于远程来源
    .filter(([, meta]) => meta?.resolved && meta.link !== true)
    .map(([name, meta]) => [name, meta.resolved]);
  const httpEntries = resolvedEntries.filter(([, resolved]) => /^https?:\/\//.test(resolved));
  const otherEntries = resolvedEntries.filter(([, resolved]) => !/^https?:\/\//.test(resolved));

  for (const [name, resolved] of otherEntries) {
    // git+/file: 等非常规来源：npm 12 默认同样禁止（allow-git=none），留给人判断是否有意为之
    console.warn(`⚠️  [lockfile] ${name} 使用非 registry 来源：${resolved}`);
  }

  const offenders = httpEntries.filter(([, resolved]) => hostOf(resolved) !== EXPECTED_HOST);
  if (offenders.length > 0) {
    report(
      `[lockfile] ${lockfile} 有 ${offenders.length} 条依赖未指向 ${EXPECTED_HOST}，npm 12 会以 EALLOWREMOTE 拒绝安装：`,
    );
    for (const [name, resolved] of offenders.slice(0, MAX_REPORTED_OFFENDERS)) {
      console.error(`   - ${name} -> ${resolved}`);
    }
    if (offenders.length > MAX_REPORTED_OFFENDERS) {
      console.error(`   ...另有 ${offenders.length - MAX_REPORTED_OFFENDERS} 条`);
    }
    return;
  }
  console.log(`✅ [lockfile] ${lockfile} 的 ${httpEntries.length} 条 tarball 来源均为 ${EXPECTED_HOST}`);
}

/** 检查各包 package.json 的 publishConfig.registry 是否指向官方 registry */
function checkPublishConfig() {
  const packagesDir = join(ROOT, "packages");
  if (!existsSync(packagesDir)) return;

  const offenders = [];
  for (const pkg of readdirSync(packagesDir)) {
    const manifest = join(packagesDir, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    const json = readJson(manifest);
    if (json === null) continue;
    const registry = json.publishConfig?.registry;
    const normalized = registry?.replace(/\/$/, "");
    if (normalized && normalized !== EXPECTED_REGISTRY.replace(/\/$/, "")) {
      offenders.push([`packages/${pkg}/package.json`, registry]);
    }
  }

  if (offenders.length > 0) {
    report("[publishConfig] 以下包声明了非官方发布 registry：");
    for (const [file, registry] of offenders) console.error(`   - ${file} -> ${registry}`);
    return;
  }
  console.log("✅ [publishConfig] 各包发布 registry 一致");
}

/** 入口：解析 --lockfile 参数，跑完所有检查后按结果决定退出码 */
function main() {
  const argv = process.argv.slice(2);
  const flagIndex = argv.indexOf("--lockfile");
  const explicitLockfile = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const lockfiles = explicitLockfile ? [explicitLockfile] : findLockfiles(ROOT);

  if (lockfiles.length === 0) {
    report("[lockfile] 未找到任何 lockfile");
  }
  for (const lockfile of lockfiles) {
    checkLockfile(lockfile);
  }
  checkPublishConfig();

  if (problems.length > 0) {
    console.error(
      `\n依赖来源门禁未通过：请把 registry 统一到 ${EXPECTED_REGISTRY} 后重新生成 lockfile（仓库根 .npmrc 已固定）。`,
    );
    process.exit(1);
  }
  console.log("\n依赖来源门禁通过。");
}

main();
