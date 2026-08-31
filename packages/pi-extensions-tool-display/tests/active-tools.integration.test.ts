import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import initializeToolDisplayExtension from "../src/index.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const DEFAULT_ACTIVE_TOOL_NAMES = ["read", "bash", "edit", "write"];
const DEFAULT_INACTIVE_TOOL_NAMES = ["grep", "find", "ls"];

test("tool-display preserves Pi's default active tool selection", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tool-display-active-tools-"));
	const agentDir = join(cwd, "agent");
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => initializeToolDisplayExtension(pi, { config: DEFAULT_TOOL_DISPLAY_CONFIG }),
		],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
	});

	try {
		assert.deepEqual(session.getActiveToolNames(), DEFAULT_ACTIVE_TOOL_NAMES);

		await session.bindExtensions({ shutdownHandler: () => {} });

		assert.deepEqual(session.getActiveToolNames(), DEFAULT_ACTIVE_TOOL_NAMES);
		const toolsByName = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
		for (const toolName of DEFAULT_ACTIVE_TOOL_NAMES) {
			assert.equal(toolsByName.get(toolName)?.sourceInfo.source, "inline");
		}
		for (const toolName of DEFAULT_INACTIVE_TOOL_NAMES) {
			assert.equal(toolsByName.get(toolName)?.sourceInfo.source, "builtin");
		}

		let inspectedReloadRegistry = false;
		await session.reload({
			beforeSessionStart: () => {
				inspectedReloadRegistry = true;
				assert.deepEqual(session.getActiveToolNames(), DEFAULT_ACTIVE_TOOL_NAMES);
				const reloadToolsByName = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
				for (const toolName of DEFAULT_ACTIVE_TOOL_NAMES) {
					assert.equal(reloadToolsByName.get(toolName)?.sourceInfo.source, "inline");
				}
				for (const toolName of DEFAULT_INACTIVE_TOOL_NAMES) {
					assert.equal(reloadToolsByName.get(toolName)?.sourceInfo.source, "builtin");
				}
			},
		});

		assert.equal(inspectedReloadRegistry, true);
		assert.deepEqual(session.getActiveToolNames(), DEFAULT_ACTIVE_TOOL_NAMES);
	} finally {
		session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
