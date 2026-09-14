import assert from "node:assert/strict";
import { test } from "node:test";
import {
	installRenderPatch,
	isCleanModePatchInstalled,
	restoreRenderPatch,
	type PatchableRenderPrototype,
} from "../src/prototype-patch.ts";

type RenderFn = (width: number) => string[];

/** 造一个可用作补丁目标的假原型。 */
function createPrototype(): PatchableRenderPrototype<RenderFn> {
	return {
		render: () => ["original"],
	};
}

/** 造一个把结果包上标记的补丁构造函数。 */
function wrapWith(marker: string): (original: RenderFn) => RenderFn {
	return (original) => (width) => [`${marker}:${original(width).join(",")}`];
}

test("安装后 render 走补丁实现，还原后回到原始实现", () => {
	const prototype = createPrototype();
	const restore = installRenderPatch(prototype, wrapWith("patched"));

	assert.equal(isCleanModePatchInstalled(prototype), true);
	assert.deepEqual(prototype.render(80), ["patched:original"]);

	restore();
	assert.equal(isCleanModePatchInstalled(prototype), false);
	assert.deepEqual(prototype.render(80), ["original"]);
});

test("重复安装是幂等的，不会叠加包裹", () => {
	const prototype = createPrototype();
	installRenderPatch(prototype, wrapWith("a"));
	const restore = installRenderPatch(prototype, wrapWith("b"));

	assert.deepEqual(prototype.render(80), ["a:original"]);
	restore();
	assert.deepEqual(prototype.render(80), ["original"]);
});

test("render 被外部替换后还原不会顶掉对方的实现", () => {
	const prototype = createPrototype();
	const restore = installRenderPatch(prototype, wrapWith("patched"));

	const foreignRender: RenderFn = () => ["foreign"];
	prototype.render = foreignRender;

	restore();
	assert.equal(prototype.render, foreignRender);
	assert.equal(isCleanModePatchInstalled(prototype), false);
});

test("render 不是函数时安装为 no-op 且不写标记", () => {
	const prototype = { render: undefined as unknown as RenderFn };
	const restore = installRenderPatch(prototype, wrapWith("patched"));

	assert.equal(prototype.render, undefined);
	assert.equal(isCleanModePatchInstalled(prototype), false);
	restore();
});

test("未安装时直接还原是安全的", () => {
	const prototype = createPrototype();
	const original = prototype.render;
	restoreRenderPatch(prototype);
	assert.equal(prototype.render, original);
});
