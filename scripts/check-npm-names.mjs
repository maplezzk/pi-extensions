#!/usr/bin/env node
/**
 * check-npm-names.mjs
 *
 * CI gate: verify npm package names are not squatted by unrelated publishers.
 *
 * For each workspace package:
 * - If the name is available (404): OK (first publish pending)
 * - If published by a known maintainer: OK
 * - If published by someone else: FAIL (name conflict)
 *
 * Also checks that peerDependencies referencing workspace packages
 * are either published on npm or part of this monorepo.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const REGISTRY = "https://registry.npmjs.org";

/** Known maintainers of this repo (npm usernames) */
const KNOWN_MAINTAINERS = ["maplezzk"];

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

// Collect workspace package names
const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PACKAGES_DIR, d.name, "package.json")))
  .map((d) => d.name);

const workspaceNames = new Set(
  packageDirs.map((dir) => JSON.parse(readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8")).name),
);

/**
 * Fetch npm registry metadata for a package name.
 * @param {string} name - npm package name to look up
 * @returns {Promise<{ status: 'available' | 'timeout' | 'published', data?: object }>}
 *   - available: 404, name is free to publish
 *   - timeout: network timeout, skip check
 *   - published: package exists, data contains registry metadata
 */
async function fetchNpmInfo(name) {
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { status: "available" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: "published", data: await res.json() };
  } catch (err) {
    if (err.name === "TimeoutError") {
      warnings.push(`⚠️  ${name}: registry timeout, skipping check`);
      return { status: "timeout" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Check 1: package names not squatted
// ---------------------------------------------------------------------------
for (const dir of packageDirs) {
  const pkgJson = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8"));
  const name = pkgJson.name;

  const result = await fetchNpmInfo(name);

  if (result.status === "timeout") continue;

  if (result.status === "available") {
    // Available — first publish pending
    warnings.push(`⚠️  ${name}: not yet published on npm (available)`);
    continue;
  }

  // Published — check maintainers
  const maintainers = (result.data.maintainers ?? []).map((m) => m.name ?? m);
  const ownedByUs = maintainers.some((m) => KNOWN_MAINTAINERS.includes(m));

  if (!ownedByUs) {
    errors.push(
      `❌ ${name}: published on npm by "${maintainers.join(", ")}" — NOT owned by us (${KNOWN_MAINTAINERS.join(", ")}). Rename required!`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 2: peerDependencies on workspace packages exist on npm
// ---------------------------------------------------------------------------
for (const dir of packageDirs) {
  const pkgJson = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8"));
  const peers = Object.keys(pkgJson.peerDependencies ?? {});

  for (const dep of peers) {
    // Only check deps that are workspace packages (our own)
    if (!workspaceNames.has(dep)) continue;

    const result = await fetchNpmInfo(dep);
    if (result.status === "timeout") continue;

    if (result.status === "available") {
      warnings.push(`⚠️  ${pkgJson.name}: peerDependency "${dep}" is a workspace package not yet on npm`);
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
  console.log(`\n💥 ${errors.length} npm name conflict(s). Rename before merging.`);
  process.exit(1);
} else {
  console.log(`\n✅ npm name check passed (${packageDirs.length} packages, ${warnings.length} warning(s)).`);
}
