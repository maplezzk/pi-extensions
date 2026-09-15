/**
 * 组件原型的方法补丁骨架。
 *
 * Pi 在扩展入口导出实际的组件类（AssistantMessageComponent / ToolExecutionComponent），
 * 因此可以用原型方法替换的方式接管渲染。这里只负责安全地安装、重复安装与还原，
 * 具体逻辑由调用方通过 buildMethod 注入。
 *
 * 补丁前的原始方法由调用方按具体类型读出后传入，所以本文件完全不碰 unknown
 * 到方法签名的断言。状态按「方法名」索引后挂在原型的一个 Symbol 上，因此同一个
 * 原型可以安全地补多个方法（例如 render 与 updateContent），互不覆盖。
 *
 * 归属判定只有一个来源：`isMethodPatchInstalled`。安装、幂等与还原三条分支
 * 都复用它，避免同一概念出现多套条件。
 */

/** 任意被补丁的原型；方法通过 Reflect 读写。 */
export type PatchablePrototype = object;

/** 被补丁的方法签名，仅用于在记录里擦除具体类型。 */
export type PatchableMethod = (...args: never[]) => unknown;

/** 单个方法的补丁记录。 */
interface MethodPatchRecord {
	/** 安装补丁前的原始方法。 */
	original: PatchableMethod;
	/** 本扩展实际写入的方法引用，用于确认当前方法是否仍归本扩展所有。 */
	installed: PatchableMethod;
}

/** 挂在原型上的补丁状态，按方法名索引。 */
interface PatchStateCarrier {
	[PATCH_STATE_KEY]?: Map<string, MethodPatchRecord>;
}

/** 安装一个方法补丁所需的输入。 */
export interface InstallMethodPatchInput<TMethod extends PatchableMethod> {
	/** 目标原型，例如 `AssistantMessageComponent.prototype`。 */
	prototype: PatchablePrototype;
	/** 要接管的方法名。 */
	methodName: string;
	/** 当前方法，由调用方按具体类型读出；非函数时安装会被跳过。 */
	currentMethod: TMethod | undefined;
	/** 由原始方法构造补丁后的方法。 */
	buildMethod: (originalMethod: TMethod) => TMethod;
}

/** 补丁状态在原型上的键；用 Symbol 避免与组件自身属性冲突。 */
const PATCH_STATE_KEY: unique symbol = Symbol("piCleanModeMethodPatches");

/** 读取原型上的方法；不存在时返回 undefined。 */
function readMethod(prototype: PatchablePrototype, methodName: string): unknown {
	return Reflect.get(prototype, methodName);
}

/** 写回原型上的方法。 */
function writeMethod(prototype: PatchablePrototype, methodName: string, value: unknown): void {
	Reflect.set(prototype, methodName, value);
}

/** 取出原型上的补丁状态；不存在时创建。 */
function getPatchState(prototype: PatchablePrototype): Map<string, MethodPatchRecord> {
	const carrier = prototype as PatchStateCarrier;
	carrier[PATCH_STATE_KEY] ??= new Map<string, MethodPatchRecord>();
	return carrier[PATCH_STATE_KEY];
}

/**
 * 判断原型上的某个方法是否仍是本扩展安装的那一个。
 *
 * 两个条件同时成立才算：存在该方法的补丁记录，且当前方法引用与记录的引用相同。
 * 任一条不成立说明补丁已被他人覆盖。
 */
export function isMethodPatchInstalled(
	prototype: PatchablePrototype,
	methodName: string,
): boolean {
	const record = getPatchState(prototype).get(methodName);
	if (!record) {
		return false;
	}
	return readMethod(prototype, methodName) === record.installed;
}

/**
 * 还原某个方法的补丁。
 *
 * 只有当前方法仍归本扩展所有时才回退到原始实现；若已被其它来源覆盖，
 * 只清理记录，避免把别人的实现顶掉。
 */
export function restoreMethodPatch(
	prototype: PatchablePrototype,
	methodName: string,
): void {
	const state = getPatchState(prototype);
	const record = state.get(methodName);

	if (record && isMethodPatchInstalled(prototype, methodName)) {
		writeMethod(prototype, methodName, record.original);
	}

	state.delete(methodName);
}

/**
 * 安装某个方法的补丁，返回还原函数。
 *
 * - 已由本扩展装过时直接返回还原函数，保证幂等；
 * - 当前方法不是函数时不做任何事，也不写记录；
 * - 始终以「当前方法」为基准包裹，因此不会重复套自己的补丁；若方法已被其它
 *   来源接管，则在对方的实现之上叠一层，而不是把对方顶掉。
 */
export function installMethodPatch<TMethod extends PatchableMethod>(
	input: InstallMethodPatchInput<TMethod>,
): () => void {
	const { prototype, methodName, currentMethod, buildMethod } = input;

	if (typeof currentMethod !== "function") {
		return () => {};
	}

	if (isMethodPatchInstalled(prototype, methodName)) {
		return () => restoreMethodPatch(prototype, methodName);
	}

	const installedMethod = buildMethod(currentMethod);
	getPatchState(prototype).set(methodName, {
		original: currentMethod,
		installed: installedMethod,
	});
	writeMethod(prototype, methodName, installedMethod);

	return () => restoreMethodPatch(prototype, methodName);
}
