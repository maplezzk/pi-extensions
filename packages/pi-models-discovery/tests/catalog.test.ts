import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import discoveryExtension, { buildModel } from "../src/index.ts";

test("locales catalog provides zh-CN and en-US for every key", () => {
	const catalog = JSON.parse(
		readFileSync(new URL("../locales/index.json", import.meta.url), "utf-8"),
	) as Record<string, Record<string, string>>;
	for (const [key, entry] of Object.entries(catalog)) {
		assert.ok(typeof entry["zh-CN"] === "string" && entry["zh-CN"].length > 0, `${key} missing zh-CN`);
		assert.ok(typeof entry["en-US"] === "string" && entry["en-US"].length > 0, `${key} missing en-US`);
	}
});

test("default export is an extension factory", async () => {
	const mod = await import("../index.ts");
	assert.equal(typeof mod.default, "function");
});

/** 隔离 agent 配置目录与网络；通过扩展入口验证读取、注册和缓存。 */
async function discoveryHarness(t: TestContext, entries?: Array<Record<string, unknown>>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-models-discovery-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	const requests: Array<{ url: string; headers: RequestInit["headers"] }> = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, headers: init.headers });
		return Response.json({ data: entries ?? [{ id: `model-${requests.length}` }] });
	});
	const registrations = new Map<string, Parameters<ExtensionAPI["registerProvider"]>[1]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi: Pick<ExtensionAPI, "registerCommand" | "on"> & {
		registerProvider(id: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]): void;
	} = {
		registerProvider: (id, config) => {
			registrations.set(id, config);
		},
		registerCommand: (name, command) => {
			commands.set(name, command);
		},
		on: () => {},
	};
	return {
		dir,
		requests,
		registrations,
		commands,
		configure: (providers: Record<string, unknown>) =>
			writeFile(join(dir, "models.json"), JSON.stringify({ providers })),
		start: () => discoveryExtension(pi as ExtensionAPI),
	};
}

const refreshContext = (allowNetwork: boolean) => ({
	allowNetwork,
	signal: new AbortController().signal,
	publish: async () => true,
});

const discoveryProvider = {
	baseUrl: "https://api.example.com/v1///",
	api: "openai-completions",
	discoverModels: true,
};

test("discovery defaults to baseUrl/models when modelsUrl is absent or empty", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		absent: discoveryProvider,
		empty: { ...discoveryProvider, modelsUrl: "" },
		nonString: { ...discoveryProvider, modelsUrl: 123 },
	});
	await h.start();
	assert.deepEqual(h.requests.map((r) => r.url), ["https://api.example.com/v1/models"]);
	assert.equal(h.registrations.size, 3);
	for (const config of h.registrations.values()) assert.equal(config.models?.[0].id, "model-1");
});

test("modelsUrl is used verbatim with existing authentication and refresh behavior", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/custom/models?region=test";
	await h.configure({ foo: {
		...discoveryProvider,
		modelsUrl,
		apiKey: "test-key",
		headers: { "X-Catalog": "test" },
	} });
	await h.start();
	const config = h.registrations.get("foo")!;
	assert.equal(config.baseUrl, discoveryProvider.baseUrl);
	assert.equal("modelsUrl" in config, false);
	assert.deepEqual(h.requests, [{ url: modelsUrl, headers: { "X-Catalog": "test", Authorization: "Bearer test-key" } }]);
	assert.equal((await config.refreshModels!(refreshContext(false)))[0].id, "model-1");
	assert.equal(h.requests.length, 1);
	assert.equal((await config.refreshModels!(refreshContext(true)))[0].id, "model-2");
	assert.equal(h.requests[1].url, modelsUrl);
	await h.commands.get("config:model-discovery-refresh")!.handler("", {
		hasUI: true,
		ui: { notify: () => {} },
	} as unknown as Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]);
	assert.equal(h.requests[2].url, modelsUrl);
});

test("request cache separates different modelsUrl values and shares identical endpoints", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		foo: { ...discoveryProvider, modelsUrl: "https://catalog.example.com/first" },
		bar: { ...discoveryProvider, modelsUrl: "https://catalog.example.com/second" },
		shared: { ...discoveryProvider, baseUrl: "https://other.example.com/v1", modelsUrl: "https://catalog.example.com/first" },
	});
	await h.start();
	assert.deepEqual(h.requests.map((r) => r.url), ["https://catalog.example.com/first", "https://catalog.example.com/second"]);
	assert.equal(h.registrations.get("foo")!.models?.[0].id, "model-1");
	assert.equal(h.registrations.get("bar")!.models?.[0].id, "model-2");
	assert.equal(h.registrations.get("shared")!.models?.[0].id, "model-1");
});

test("shared modelsUrl does not mix provider compatibility settings", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/models";
	await h.configure({
		foo: { ...discoveryProvider, modelsUrl, compat: { supportsDeveloperRole: true } },
		bar: { ...discoveryProvider, modelsUrl, compat: { supportsDeveloperRole: false } },
	});
	await h.start();
	assert.equal(h.requests.length, 2);
	assert.deepEqual(h.registrations.get("foo")!.models?.[0].compat, { supportsDeveloperRole: true });
	assert.deepEqual(h.registrations.get("bar")!.models?.[0].compat, { supportsDeveloperRole: false });
});

test("a failing modelsUrl keeps fallback registration without retrying baseUrl", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/models";
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return url === modelsUrl ? new Response(null, { status: 401 }) : Response.json({ data: [{ id: "healthy" }] });
	});
	await h.configure({
		failed: { ...discoveryProvider, modelsUrl, models: [{ id: "handwritten" }] },
		healthy: discoveryProvider,
	});
	await h.start();
	assert.deepEqual(requests, [modelsUrl, "https://api.example.com/v1/models"]);
	const failed = h.registrations.get("failed")!;
	assert.equal(failed.baseUrl, discoveryProvider.baseUrl);
	assert.equal(failed.models, undefined, "do not override handwritten fallback models");
	await assert.rejects(() => failed.refreshModels!(refreshContext(false)));
	assert.equal(h.registrations.get("healthy")!.models?.[0].id, "healthy");
});

test("providers without modelsUrl reuse cache fingerprints from before this feature", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({ foo: discoveryProvider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([discoveryProvider.baseUrl, discoveryProvider.api, "", {}, {}]),
			fetchedAt: "2026-01-01T00:00:00.000Z",
			models: [buildModel("cached", undefined, undefined, undefined, undefined)],
		} },
	}));
	await h.start();
	assert.equal(h.requests.length, 0);
	assert.equal(h.registrations.get("foo")!.models?.[0].id, "cached");
});

test("persistent cache is reused and invalidated when modelsUrl is added, changed or removed", async (t) => {
	const h = await discoveryHarness(t);
	for (const modelsUrl of [undefined, "https://catalog.example.com/first", "https://catalog.example.com/second", undefined]) {
		await h.configure({ foo: { ...discoveryProvider, modelsUrl } });
		await h.start();
		const count = h.requests.length;
		await h.start();
		assert.equal(h.requests.length, count, "unchanged configuration must not fetch again");
		assert.equal(h.registrations.get("foo")!.models?.[0].id, `model-${count}`);
	}
	assert.deepEqual(h.requests.map((r) => r.url), [
		"https://api.example.com/v1/models",
		"https://catalog.example.com/first",
		"https://catalog.example.com/second",
		"https://api.example.com/v1/models",
	]);
});

test("context window falls back to vLLM max_model_len", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "vllm", max_model_len: 200_000 },
		{ id: "explicit", context_window: 128_000, max_model_len: 200_000 },
		{ id: "bare" },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	const windows = h.registrations.get("foo")!.models!.map((m) => [m.id, m.contextWindow]);
	assert.deepEqual(windows, [["vllm", 200_000], ["explicit", 128_000], ["bare", 1_000_000]]);
});

test("discovered models expose xhigh and max thinking levels", () => {
	const model = buildModel("some-model", undefined, undefined, undefined, undefined) as unknown as Model<Api>;
	assert.deepEqual(getSupportedThinkingLevels(model), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});
