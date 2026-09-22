import assert from "node:assert/strict";
import test from "node:test";
import { createComposeUiTool } from "../src/compose-tool.ts";
import { createRenderUiTool } from "../src/tool.ts";
import { DEFAULT_CONFIG, type JsonRenderConfig } from "../src/config.ts";

/** A configuration with the master switch flipped. */
function disabled(): JsonRenderConfig {
	return { ...DEFAULT_CONFIG, composition: { ...DEFAULT_CONFIG.composition }, enabled: false };
}

/** A candidate the composer could place; only used to reach the gates under test. */
const candidate = {
	id: "panel",
	description: "Outer container for the panel.",
	root: true,
	element: { type: "Box", props: { flexDirection: "column" } },
};

/** A minimal valid spec, so render_ui gets past schema validation. */
const spec = {
	root: "root",
	elements: { root: { type: "Text", props: { text: "hi" }, children: [] } },
};

/** The tool context is unused by the refusal paths under test. */
const stubContext = {} as never;

/**
 * Run a callback with fetch replaced.
 *
 * Returning the call count lets a test prove a refusal happened before any request, rather
 * than merely observing that it returned an error afterwards.
 */
async function withoutNetwork<T>(run: () => Promise<T>): Promise<{ result: T; fetchCalls: number }> {
	const original = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error("no request is expected in this test");
	}) as typeof fetch;
	try {
		return { result: await run(), fetchCalls };
	} finally {
		globalThis.fetch = original;
	}
}

test("the master switch stops compose_ui before it reaches the transport", async () => {
	const tool = createComposeUiTool({
		getConfig: disabled,
		getAvailability: () => ({ available: true }),
	});
	const { result, fetchCalls } = await withoutNetwork(() =>
		tool.execute("call-1", { prompt: "panel", candidates: [candidate] }, undefined, undefined, stubContext),
	);
	assert.equal(fetchCalls, 0);
	assert.notEqual(result.details.error, undefined);
});

test("the master switch stops render_ui as well", async () => {
	const tool = createRenderUiTool({ getConfig: disabled });
	const result = await tool.execute("call-2", spec as never, undefined, undefined, stubContext);
	assert.notEqual(result.details.error, undefined);
});

test("a disabled composer is reported instead of attempted", async () => {
	const tool = createComposeUiTool({
		getConfig: () => ({ ...DEFAULT_CONFIG, composition: { ...DEFAULT_CONFIG.composition } }),
		getAvailability: () => ({ available: false, reason: "disabled" }),
	});
	const { result, fetchCalls } = await withoutNetwork(() =>
		tool.execute("call-3", { prompt: "panel", candidates: [candidate] }, undefined, undefined, stubContext),
	);
	assert.equal(fetchCalls, 0);
	assert.notEqual(result.details.error, undefined);
});

test("the master switch and the composition switch report different reasons", async () => {
	const offTool = createComposeUiTool({
		getConfig: disabled,
		getAvailability: () => ({ available: true }),
	});
	const missingKeyTool = createComposeUiTool({
		getConfig: () => ({ ...DEFAULT_CONFIG, composition: { ...DEFAULT_CONFIG.composition } }),
		getAvailability: () => ({ available: false, reason: "missingKey" }),
	});
	const params = { prompt: "panel", candidates: [candidate] };
	const offResult = await offTool.execute("call-4", params, undefined, undefined, stubContext);
	const keyResult = await missingKeyTool.execute("call-5", params, undefined, undefined, stubContext);
	assert.notEqual(offResult.details.error, keyResult.details.error);
});
