/**
 * 面板连线测试：真正打开 /config:model-discovery 注册的配置面板，用键盘事件走完整交互。
 *
 * 字段逻辑在 config-panel.test.ts 覆盖；这里只盯住两件事：
 * 1. 不带参数的配置命令会打开面板；
 * 2. 面板里关掉某个 provider 的模型发现时，models.json 真的去掉 discoverModels 标记并注销该 provider
 *    （不只是面板内部状态变了）。
 *
 * 测试不联网：发现请求会打到 baseUrl，这里统一让 fetch 失败，验证的是控制流而不是网络结果。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTER } from "./panel-driver.ts";
import { createScriptedUi } from "./panel-driver.ts";

/** 配置命令处理器的读形态。 */
type RegisteredCommand = {
	handler: (args: string, context: unknown) => Promise<void>;
};

test("不带参数的配置命令打开面板，关掉发现开关会去掉标记并注销 provider", async (t) => {
	initTheme("dark");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-models-discovery-panel-wiring-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// 发现请求一律失败，避免测试碰到真实网络。
	const previousFetch = globalThis.fetch;
	/** 假的 fetch：直接抛错，让发现流程走失败分支而不发真实请求。 */
	const offlineFetch = async (): Promise<Response> => {
		throw new Error("offline in test");
	};
	globalThis.fetch = offlineFetch as unknown as typeof globalThis.fetch;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		globalThis.fetch = previousFetch;
	});

	await mkdir(join(agentDir, "extensions"), { recursive: true });
	const modelsPath = join(agentDir, "models.json");
	await writeFile(
		modelsPath,
		JSON.stringify({
			providers: {
				demo: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", discoverModels: true },
			},
		}),
	);

	const commands = new Map<string, RegisteredCommand>();
	const unregistered: string[] = [];
	const pi = {
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
		registerProvider: () => undefined,
		unregisterProvider: (id: string) => unregistered.push(id),
		registerEntryRenderer: () => undefined,
		on: () => undefined,
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const moduleUrl = new URL("../index.ts", import.meta.url);
	moduleUrl.searchParams.set("panel-wiring-test", "enabled");
	const { default: modelsDiscovery } = await import(moduleUrl.href);
	await modelsDiscovery(pi);

	// 打开 1（顶层）：唯一的 provider 在第 1 行，Enter 进它的字段页。
	// 打开 2（字段页）：「模型发现」是第 1 行，空格原地切换成关；Esc 关闭。
	const ui = createScriptedUi([[ENTER], [" ", "\u001B"]]);
	const command = commands.get("config:model-discovery");
	assert.ok(command, "配置命令必须注册");
	await command.handler("", {
		hasUI: true,
		ui: {
			custom: ui.custom,
			confirm: async () => false,
			notify: () => undefined,
			input: async () => undefined,
			select: async () => undefined,
		},
	});

	assert.equal(ui.openCount(), 3, "面板应该按顶层/provider 页交替打开，并在最后被 Esc 关闭");
	const saved = JSON.parse(await readFile(modelsPath, "utf8")) as {
		providers: Record<string, Record<string, unknown>>;
	};
	assert.equal(saved.providers.demo?.discoverModels, undefined, "关掉发现后不应再留 discoverModels 标记");
	// 其余字段原样保留，不能因为面板改一项就把 provider 整条抹掉。
	assert.equal(saved.providers.demo?.baseUrl, "http://127.0.0.1:1/v1");
	assert.equal(saved.providers.demo?.api, "openai-completions");
	assert.deepEqual(unregistered, ["demo"], "关掉发现后应注销该 provider");
});
