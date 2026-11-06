import assert from "node:assert/strict";
import { test } from "node:test";
import {
	installMethodPatch,
	isMethodPatchInstalled,
	restoreMethodPatch,
	type PatchablePrototype,
} from "../src/prototype-patch.ts";

type RenderFn = (width: number) => string[];

/** 造一个带 render 方法的假原型。 */
function createPrototype(): PatchablePrototype & { render: RenderFn } {
	return { render: () => ["original"] };
}

/** 造一个把结果包上标记的补丁构造函数。 */
function wrapWith(marker: string): (original: RenderFn) => RenderFn {
	return (original) => (width) => [`${marker}:${original(width).join(",")}`];
}

/** 以 render 方法为目标安装补丁的简写。 */
function installRender(
	prototype: PatchablePrototype & { render: RenderFn },
	marker: string,
): () => void {
	return installMethodPatch<RenderFn>({
		prototype,
		methodName: "render",
		currentMethod: prototype.render,
		buildMethod: wrapWith(marker),
	});
}

test("安装后方法走补丁实现，还原后回到原始实现", () => {
	const prototype = createPrototype();
	const restore = installRender(prototype, "patched");

	assert.equal(isMethodPatchInstalled(prototype, "render"), true);
	assert.deepEqual(prototype.render(80), ["patched:original"]);

	restore();
	assert.equal(isMethodPatchInstalled(prototype, "render"), false);
	assert.deepEqual(prototype.render(80), ["original"]);
});

test("重复安装是幂等的，不会叠加包裹", () => {
	const prototype = createPrototype();
	installRender(prototype, "a");
	const restore = installRender(prototype, "b");

	assert.deepEqual(prototype.render(80), ["a:original"]);
	restore();
	assert.deepEqual(prototype.render(80), ["original"]);
});

test("同一原型可以同时补两个方法且互不影响", () => {
	type UpdateFn = (value: number) => number;
	const prototype: PatchablePrototype & { render: RenderFn; update: UpdateFn } = {
		render: () => ["original"],
		update: (value) => value,
	};
	const restoreRender = installRender(prototype, "patched");
	const restoreUpdate = installMethodPatch<UpdateFn>({
		prototype,
		methodName: "update",
		currentMethod: prototype.update,
		buildMethod: (original) => (value) => original(value) + 1,
	});

	assert.deepEqual(prototype.render(80), ["patched:original"]);
	assert.equal(prototype.update(1), 2);
	assert.equal(isMethodPatchInstalled(prototype, "render"), true);
	assert.equal(isMethodPatchInstalled(prototype, "update"), true);

	restoreRender();
	assert.deepEqual(prototype.render(80), ["original"]);
	assert.equal(prototype.update(1), 2, "还原 render 不应影响 update 的补丁");

	restoreUpdate();
	assert.equal(prototype.update(1), 1);
});

test("方法被外部替换后还原不会顶掉对方的实现", () => {
	const prototype = createPrototype();
	const restore = installRender(prototype, "patched");

	const foreignRender: RenderFn = () => ["foreign"];
	prototype.render = foreignRender;

	restore();
	assert.equal(prototype.render, foreignRender);
	assert.equal(isMethodPatchInstalled(prototype, "render"), false);
});

test("目标方法不是函数时安装为 no-op 且不写记录", () => {
	const prototype: PatchablePrototype & { render: RenderFn | undefined } = { render: undefined };
	installMethodPatch<RenderFn>({
		prototype,
		methodName: "render",
		currentMethod: prototype.render,
		buildMethod: wrapWith("patched"),
	});

	assert.equal(prototype.render, undefined);
	assert.equal(isMethodPatchInstalled(prototype, "render"), false);
});

test("未安装时直接还原是安全的", () => {
	const prototype = createPrototype();
	const original = prototype.render;
	restoreMethodPatch(prototype, "render");
	assert.equal(prototype.render, original);
});
