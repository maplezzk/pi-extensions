#!/usr/bin/env node
/**
 * check-package-config.mjs
 *
 * CI gate: validate monorepo package configuration consistency.
 *
 * Checks:
 * 1. release-please-config.json paths exist on disk
 * 2. release.yml publish matrix covers all release-please packages
 * 3. Each package has required files (package.json, index.ts, README.md, README.zh-CN.md, tsconfig.json)
 * 4. package.json has required fields (name, version, description, main, exports, files, license)
 * 5. i18n catalogs have both zh-CN and en-US for every key
 * 6. package.json "files" includes README.md and README.zh-CN.md
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

function error(msg) {
  errors.push(`❌ ${msg}`);
}

function warn(msg) {
  warnings.push(`⚠️  ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. Load release-please-config.json
// ---------------------------------------------------------------------------
const rpConfigPath = join(ROOT, "release-please-config.json");
if (!existsSync(rpConfigPath)) {
  error("release-please-config.json not found at repo root");
} else {
  const rpConfig = JSON.parse(readFileSync(rpConfigPath, "utf8"));
  const rpPackages = Object.keys(rpConfig.packages ?? {});

  // 1a. Each path in release-please-config must exist on disk
  for (const pkgPath of rpPackages) {
    const absPath = join(ROOT, pkgPath);
    if (!existsSync(absPath)) {
      error(`release-please-config.json references "${pkgPath}" but directory does not exist`);
    }
  }

  // 1b. Each actual package directory should be in release-please-config
  const actualDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PACKAGES_DIR, d.name, "package.json")))
    .map((d) => `packages/${d.name}`);

  for (const dir of actualDirs) {
    if (!rpPackages.includes(dir)) {
      error(`Package "${dir}" exists on disk but is missing from release-please-config.json`);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. release.yml publish matrix covers all release-please packages
  // ---------------------------------------------------------------------------
  const releaseYmlPath = join(ROOT, ".github/workflows/release.yml");
  if (!existsSync(releaseYmlPath)) {
    error(".github/workflows/release.yml not found");
  } else {
    const releaseContent = readFileSync(releaseYmlPath, "utf8");
    // Extract "- dir: packages/xxx" entries from the publish-npm matrix
    const matrixDirs = [...releaseContent.matchAll(/-\s*dir:\s*(packages\/[\w-]+)/g)].map((m) => m[1]);

    if (matrixDirs.length === 0) {
      error("release.yml: no '- dir: packages/...' entries found in publish matrix");
    } else {
      for (const pkgPath of rpPackages) {
        if (!matrixDirs.includes(pkgPath)) {
          error(`release.yml publish matrix is missing "${pkgPath}" (present in release-please-config.json)`);
        }
      }

      for (const dir of matrixDirs) {
        if (!rpPackages.includes(dir)) {
          warn(`release.yml publish matrix has "${dir}" which is not in release-please-config.json`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3-6. Per-package checks
// ---------------------------------------------------------------------------
const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PACKAGES_DIR, d.name, "package.json")))
  .map((d) => d.name);

const REQUIRED_FILES = ["package.json", "index.ts", "README.md", "README.zh-CN.md", "tsconfig.json"];
const REQUIRED_PKG_FIELDS = ["name", "version", "description", "main", "exports", "files", "license"];

for (const dir of packageDirs) {
  const pkgRoot = join(PACKAGES_DIR, dir);
  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const label = pkgJson.name ?? dir;

  // 3. Required files
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(pkgRoot, file))) {
      error(`${label}: missing required file "${file}"`);
    }
  }

  // 4. Required package.json fields
  for (const field of REQUIRED_PKG_FIELDS) {
    if (pkgJson[field] === undefined || pkgJson[field] === null || pkgJson[field] === "") {
      error(`${label}: package.json missing required field "${field}"`);
    }
  }

  // 5. files field should include READMEs
  if (Array.isArray(pkgJson.files)) {
    if (!pkgJson.files.includes("README.md")) {
      warn(`${label}: package.json "files" does not include README.md`);
    }
    if (!pkgJson.files.includes("README.zh-CN.md")) {
      warn(`${label}: package.json "files" does not include README.zh-CN.md`);
    }
  }

  // 6. i18n catalog consistency
  const localesDir = join(pkgRoot, "locales");
  if (existsSync(localesDir)) {
    const catalogFiles = readdirSync(localesDir).filter((f) => f.endsWith(".json"));
    for (const catalogFile of catalogFiles) {
      const catalog = JSON.parse(readFileSync(join(localesDir, catalogFile), "utf8"));
      for (const [key, translations] of Object.entries(catalog)) {
        if (typeof translations !== "object" || translations === null) continue;
        const langs = Object.keys(translations);
        if (!langs.includes("zh-CN")) {
          error(`${label}: locales/${catalogFile} key "${key}" missing zh-CN`);
        }
        if (!langs.includes("en-US")) {
          error(`${label}: locales/${catalogFile} key "${key}" missing en-US`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (warnings.length > 0) {
  console.log("\n--- Warnings ---");
  for (const w of warnings) console.log(w);
}

if (errors.length > 0) {
  console.log("\n--- Errors ---");
  for (const e of errors) console.log(e);
  console.log(`\n💥 ${errors.length} error(s) found. Fix them before merging.`);
  process.exit(1);
} else {
  console.log(`✅ Package config check passed (${packageDirs.length} packages, ${warnings.length} warning(s)).`);
}
