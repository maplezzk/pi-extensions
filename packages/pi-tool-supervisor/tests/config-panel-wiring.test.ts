/**
 * 面板连线测试：真正打开 /config:tool-supervisor 注册的配置面板，用键盘事件走完整交互。
 *
 * 字段逻辑在 config-panel.test.ts 覆盖；这里只盯住三件事：
 * 1. 不带参数的配置命令会打开面板；
 * 2. 面板里改总开关会写盘（不只是面板内部状态变了）；
 * 3. 删除 reviewer 需要先确认，确认后从配置里消失。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createScriptedUi, down, ENTER } from "./panel-driver.ts";

/** 配置命令处理器的读形态。 */
type RegisteredCommand = {
	handler: (args: string, context: unknown) => Promise<void>;
};

/** 写入临时 agent 目录里的一份基础配置，并返回配置文件路径。 */
async function seedConfig(agentDir: string): Promise<string> {
	const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
	await mkdir(configDirectory, { recursive: true });
	const configPath = join(configDirectory, "config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			enabled: true,
			reviewers: [{ name: "reviewer", model: "provider/model", rulesFile: "rules.md" }],
		}),
	);
	return configPath;
}

/** 注册扩展并返回配置命令表。 */
async function loadCommands(): Promise<Map<string, RegisteredCommand>> {
	const commands = new Map<string, RegisteredCommand>();
	const pi = {
		getAllTools: () => [],
		registerEntryRenderer: () => undefined,
		appendEntry: () => undefined,
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
		on: () => undefined,
	} as unknown as Parameters<typeof import("../src/index.ts").default>[0];
	const moduleUrl = new URL("../src/index.ts", import.meta.url);
	moduleUrl.searchParams.set("panel-wiring-test", "enabled");
	const { default: supervisor } = await import(moduleUrl.href);
	supervisor(pi);
	return commands;
}

test("不带参数的配置命令打开面板，切换总开关立即写盘", async (t) => {
	initTheme("dark");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-wiring-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const configPath = await seedConfig(agentDir);
	const commands = await loadCommands();

	// 顶层第 1 行就是总开关，空格原地切换成关，然后 Esc 退出。
	const ui = createScriptedUi([[" ", "\u001B"]]);
	await commands.get("config:tool-supervisor")?.handler("", {
		hasUI: true,
		modelRegistry: { getAvailable: () => [] },
		ui: {
			custom: ui.custom,
			confirm: async () => false,
			notify: () => undefined,
		},
	});

	assert.equal(ui.openCount(), 1);
	const saved = JSON.parse(await readFile(configPath, "utf8")) as { enabled?: boolean };
	assert.equal(saved.enabled, false, "切换总开关必须立刻写盘");
});

test("删除 reviewer 先确认，确认后从配置里移除", async (t) => {
	initTheme("dark");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-wiring-delete-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const configPath = await seedConfig(agentDir);
	const commands = await loadCommands();

	// 打开 1（顶层）：进入唯一 reviewer 的字段页。
	// 打开 2（字段页）：下移到最后的「删除此审查器」并 Enter。
	// 打开 3（顶层）：删除后回到顶层，Esc 退出。
	const ui = createScriptedUi([
		[...down(6), ENTER],
		[...down(9), ENTER],
		["\u001B"],
	]);
	await commands.get("config:tool-supervisor")?.handler("", {
		hasUI: true,
		modelRegistry: { getAvailable: () => [] },
		ui: {
			custom: ui.custom,
			confirm: async () => true,
			notify: () => undefined,
		},
	});

	const saved = JSON.parse(await readFile(configPath, "utf8")) as {
		reviewers: unknown[];
	};
	assert.deepEqual(saved.reviewers, [], "确认删除后 reviewer 必须从配置里移除");
});

test("删除确认被拒绝时 reviewer 保持不变", async (t) => {
	initTheme("dark");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-wiring-keep-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const configPath = await seedConfig(agentDir);
	const commands = await loadCommands();

	const ui = createScriptedUi([
		[...down(6), ENTER],
		[...down(9), ENTER],
		// 拒绝确认后字段页重新打开，直接 Esc 退出。
		["\u001B"],
		["\u001B"],
	]);
	await commands.get("config:tool-supervisor")?.handler("", {
		hasUI: true,
		modelRegistry: { getAvailable: () => [] },
		ui: {
			custom: ui.custom,
			confirm: async () => false,
			notify: () => undefined,
		},
	});

	const saved = JSON.parse(await readFile(configPath, "utf8")) as {
		reviewers: { name?: string }[];
	};
	assert.equal(saved.reviewers.length, 1);
	assert.equal(saved.reviewers[0]?.name, "reviewer");
});
