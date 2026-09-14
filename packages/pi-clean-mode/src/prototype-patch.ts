/**
 * 组件原型的渲染补丁骨架。
 *
 * Pi 在扩展入口导出实际的组件类（AssistantMessageComponent / ToolExecutionComponent），
 * 因此可以用原型替换的方式接管 render()。这里只负责安全地安装、重复安装与还原，
 * 具体渲染逻辑由调用方通过 buildRender 注入。
 *
 * 归属判定只有一个来源：`isCleanModePatchInstalled`。安装、幂等与还原三条分支
 * 都复用它，避免同一概念出现多套条件。
 */

/** 被补丁的原型上需要的最小结构。 */
export interface PatchableRenderPrototype<TRender extends (...args: never[]) => unknown> {
	render: TRender;
	/** 安装补丁前的原始 render，用于还原。 */
	__piCleanModeOriginalRender?: TRender;
	/** 本扩展实际写入的 render 引用，用于确认当前 render 是否仍归本扩展所有。 */
	__piCleanModeInstalledRender?: TRender;
	/** 补丁所有者标记；避免把其它扩展装的补丁误判成本扩展的。 */
	__piCleanModeOwner?: object;
}

/** 补丁所有者标记。 */
const PATCH_OWNER = {};

/**
 * 判断原型上的 render 是否仍是本扩展安装的那一个。
 *
 * 三个条件同时成立才算：所有者标记匹配、记录过安装后的 render 引用、
 * 且当前 render 与记录的引用相同。任一条不成立说明补丁已被他人覆盖。
 */
export function isCleanModePatchInstalled<TRender extends (...args: never[]) => unknown>(
	prototype: PatchableRenderPrototype<TRender>,
): boolean {
	return prototype.__piCleanModeOwner === PATCH_OWNER
		&& typeof prototype.__piCleanModeOriginalRender === "function"
		&& prototype.render === prototype.__piCleanModeInstalledRender;
}

/** 清除补丁标记，但不动 render；用于补丁已被他人覆盖的情况。 */
function clearPatchMarkers<TRender extends (...args: never[]) => unknown>(
	prototype: PatchableRenderPrototype<TRender>,
): void {
	delete prototype.__piCleanModeOriginalRender;
	delete prototype.__piCleanModeInstalledRender;
	delete prototype.__piCleanModeOwner;
}

/**
 * 还原渲染补丁。
 *
 * 只有当前 render 仍归本扩展所有时才回退到原始实现；若已被其它来源覆盖，
 * 只清理标记，避免把别人的 render 顶掉。
 */
export function restoreRenderPatch<TRender extends (...args: never[]) => unknown>(
	prototype: PatchableRenderPrototype<TRender>,
): void {
	if (isCleanModePatchInstalled(prototype)) {
		const originalRender = prototype.__piCleanModeOriginalRender;
		if (typeof originalRender === "function") {
			prototype.render = originalRender;
		}
	}
	clearPatchMarkers(prototype);
}

/**
 * 安装渲染补丁，返回还原函数。
 *
 * - 已由本扩展装过时直接返回还原函数，保证幂等；
 * - 原型上残留本扩展的旧补丁（例如 render 被 Pi 重建）时先还原再安装；
 * - render 不是函数时不做任何事，也不写标记。
 */
export function installRenderPatch<TRender extends (...args: never[]) => unknown>(
	prototype: PatchableRenderPrototype<TRender>,
	buildRender: (originalRender: TRender) => TRender,
): () => void {
	if (typeof prototype.render !== "function") {
		return () => {};
	}

	if (isCleanModePatchInstalled(prototype)) {
		return () => restoreRenderPatch(prototype);
	}

	const staleOriginal = prototype.__piCleanModeOriginalRender;
	const hasStaleOwnPatch =
		prototype.__piCleanModeOwner === PATCH_OWNER && typeof staleOriginal === "function";
	const baseRender = hasStaleOwnPatch && staleOriginal ? staleOriginal : prototype.render;
	clearPatchMarkers(prototype);

	const installedRender = buildRender(baseRender);
	prototype.__piCleanModeOriginalRender = baseRender;
	prototype.__piCleanModeInstalledRender = installedRender;
	prototype.__piCleanModeOwner = PATCH_OWNER;
	prototype.render = installedRender;

	return () => restoreRenderPatch(prototype);
}
