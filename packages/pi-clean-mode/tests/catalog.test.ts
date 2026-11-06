import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** 本地化文案的 catalog 文件路径。 */
const CATALOG_URL = new URL("../locales/index.json", import.meta.url);
/** 支持的两种语言。 */
const REQUIRED_LOCALES = ["zh-CN", "en-US"] as const;

/** 读取 catalog 并按 key 校验两种语言都存在非空文案。 */
function assertCatalogComplete(): void {
	const catalog = JSON.parse(readFileSync(CATALOG_URL, "utf8")) as Record<
		string,
		Record<string, string>
	>;
	const keys = Object.keys(catalog);

	assert.ok(keys.length > 0, "catalog 不应为空");

	for (const key of keys) {
		for (const locale of REQUIRED_LOCALES) {
			const message = catalog[key]?.[locale];
			assert.equal(typeof message, "string", `${key} 缺少 ${locale}`);
			assert.ok((message ?? "").trim().length > 0, `${key} 的 ${locale} 文案为空`);
		}
	}
}

test("catalog 的每个 key 都有 zh-CN 与 en-US 文案", assertCatalogComplete);
