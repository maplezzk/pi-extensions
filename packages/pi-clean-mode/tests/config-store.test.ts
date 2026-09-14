import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, normalizeConfig, saveConfig } from "../src/config-store.ts";
import { DEFAULT_CLEAN_MODE_CONFIG } from "../src/types.ts";

/**
 * 在临时 agent 目录里执行一段断言，结束后恢复环境变量并清理目录。
 *
 * @param run 接收临时 agent 目录路径的断言回调。
 */
function withAgentDir(run: (agentDir: string) => void): void {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-clean-mode-config-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		run(agentDir);
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
}

/** 把内容写进临时 agent 目录下的配置文件。 */
function writeConfigFile(agentDir: string, content: string): void {
	const path = configPath();
	mkdirSync(join(agentDir, "extensions", "pi-clean-mode"), { recursive: true });
	writeFileSync(path, content, "utf8");
}

test("配置文件缺失时返回默认配置且无诊断信息", () => {
	withAgentDir(() => {
		const loaded = loadConfig();
		assert.deepEqual(loaded.config, DEFAULT_CLEAN_MODE_CONFIG);
		assert.equal(loaded.diagnostic, undefined);
	});
});

test("读取部分字段时用默认值补齐其余字段", () => {
	withAgentDir((agentDir) => {
		writeConfigFile(agentDir, JSON.stringify({ enabled: false, showRunHeader: false }));
		const loaded = loadConfig();

		assert.equal(loaded.config.enabled, false);
		assert.equal(loaded.config.showRunHeader, false);
		assert.equal(loaded.config.autoExpandWhileRunning, DEFAULT_CLEAN_MODE_CONFIG.autoExpandWhileRunning);
		assert.equal(loaded.config.showExpandHint, DEFAULT_CLEAN_MODE_CONFIG.showExpandHint);
	});
});

test("配置文件不是合法 JSON 时回落默认值并给出诊断信息", () => {
	withAgentDir((agentDir) => {
		writeConfigFile(agentDir, "{ not json");
		const loaded = loadConfig();

		assert.deepEqual(loaded.config, DEFAULT_CLEAN_MODE_CONFIG);
		assert.equal(typeof loaded.diagnostic, "string");
	});
});

test("字段类型不符时回落到默认值", () => {
	const normalized = normalizeConfig({ enabled: "yes", showRunHeader: 1 });
	assert.equal(normalized.enabled, DEFAULT_CLEAN_MODE_CONFIG.enabled);
	assert.equal(normalized.showRunHeader, DEFAULT_CLEAN_MODE_CONFIG.showRunHeader);
});

test("写入后可以原样读回", () => {
	withAgentDir(() => {
		const config = { ...DEFAULT_CLEAN_MODE_CONFIG, autoExpandWhileRunning: false };
		const result = saveConfig(config);

		assert.equal(result.success, true);
		assert.deepEqual(loadConfig().config, config);
	});
});
