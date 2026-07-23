#!/usr/bin/env node
/**
 * check-npm-publish-health.mjs
 *
 * CI 门禁：检测会破坏 npm 自动发布的「配置/版本漂移」，覆盖 release-please 已打 tag
 * 但 npm publish 失败（如缺 OIDC trusted publisher）导致 git 与 npm 版本脱节这类事故。
 *
 * 两项检查均为「告警」（非阻塞）——既保证可见性，又不误伤新包首发等合法瞬态：
 *
 *   A. trusted publisher 就绪性：某个已发布且归我们所有的包，其 latest 版本若没有
 *      provenance 证明，说明它是手动发布的，未配置 trusted publisher —— 之后 CI 走
 *      OIDC 自动发布会 404。需在 npmjs.com 给该包配置 trusted publisher。
 *
 *   B. manifest ↔ npm 版本一致性：.release-please-manifest.json 期望的版本若比 npm
 *      latest 还新，说明 release-please 已 bump/打 tag 但发布很可能失败了。
 *      在 release-please 分支上跳过此项（那里的 bump 是预期内的「待发布」状态）。
 *
 * 告警以非零可见方式输出但 exit 0，不阻断 CI；如需升级为硬失败，可将警告改为 error。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchNpmInfo, semverGreater, KNOWN_MAINTAINERS } from "./lib/npm-registry.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const MANIFEST_PATH = join(ROOT, ".release-please-manifest.json");

/** release-please 分支名前缀：该分支上的 manifest bump 是预期内的待发布状态 */
const RELEASE_PLEASE_BRANCH_PREFIX = "release-please";

/** @type {string[]} */
const warnings = [];

// 收集 workspace 包目录
const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PACKAGES_DIR, d.name, "package.json")))
  .map((d) => d.name);

// release-please 分支上跳过版本一致性检查（bump 是预期内的待发布状态）
const branch = process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? "";
const isReleasePleaseBranch = branch.startsWith(RELEASE_PLEASE_BRANCH_PREFIX);

// 读取 release-please manifest（各包预期版本，key 形如 "packages/pi-metrics"）
const manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
  : {};

for (const dir of packageDirs) {
  const pkgJson = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8"));
  const name = pkgJson.name;

  const result = await fetchNpmInfo(name);
  if (result.status === "timeout") {
    warnings.push(`⚠️  ${name}: registry 超时，跳过本次检查`);
    continue;
  }
  if (result.status === "available") {
    // 尚未发布：首发 pending，无需检查发布健康度
    continue;
  }

  const data = result.data;
  const latest = data["dist-tags"]?.latest;
  const latestMeta = latest ? data.versions?.[latest] : undefined;
  const maintainers = (data.maintainers ?? []).map((m) => m.name ?? m);
  const ownedByUs = maintainers.some((m) => KNOWN_MAINTAINERS.includes(m));

  // ── Check A: trusted publisher 就绪性（provenance）──
  if (ownedByUs && latestMeta) {
    const hasProvenance = Boolean(latestMeta.dist?.attestations?.provenance);
    if (!hasProvenance) {
      warnings.push(
        `⚠️  ${name}@${latest}: 无 provenance 证明（系手动发布）。CI 自动发布需在 npmjs.com 配置 trusted publisher，否则 OIDC 发布会 404。`,
      );
    }
  }

  // ── Check B: manifest ↔ npm 版本一致性 ──
  if (!isReleasePleaseBranch) {
    const expected = manifest[`packages/${dir}`];
    if (expected && latest && semverGreater(expected, latest)) {
      warnings.push(
        `⚠️  ${name}: manifest 期望 ${expected}，但 npm latest 仅 ${latest} —— 可能发布失败（检查 trusted publisher / release 日志）。`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
if (warnings.length > 0) {
  console.log("\n--- Publish health warnings ---");
  for (const w of warnings) console.log(w);
  console.log(`\n⚠️  ${warnings.length} 个发布健康告警：自动发布可能失败，请排查上列问题。`);
} else {
  console.log(`\n✅ npm publish-health check passed (${packageDirs.length} packages).`);
}

// 告警为非阻塞：始终 exit 0（如需硬失败，将 warnings 升级为 errors 并 exit 1）
