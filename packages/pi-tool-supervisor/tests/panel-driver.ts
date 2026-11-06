/**
 * 配置面板的测试驱动。
 *
 * 面板走 `ctx.ui.custom`，测试里把工厂真的执行一遍拿到组件，再用原始按键序列走完整交互：
 * 方向键平移选中项、Enter 激活当前行（开关原地切换、二级列表打开）、二级列表里继续用同样的键。
 * 这样测的是面板真实行为，而不是绕过面板直接改配置。
 */

import type { Component } from "@earendil-works/pi-tui";

/** 方向键下。 */
export const DOWN = "\u001B[B";
/** Enter。 */
export const ENTER = "\r";

/** 可发按键的最小组件。 */
export interface KeyDriven {
	/** 送一个原始按键序列。 */
	handleInput(data: string): void;
}

/** 捕获面板组件的最小 UI。 */
export interface CapturingUi {
	/** 供 `ctx.ui.custom` 使用的函数，会执行面板工厂。 */
	custom(factory: unknown): Promise<undefined>;
	/** 最近一次打开的面板组件。 */
	component(): KeyDriven | undefined;
	/** 面板是否被打开过。 */
	opened(): boolean;
	/** 关闭面板时收到的回调返回值。 */
	result(): unknown;
	/** 已经打开过的面板次数。 */
	openCount(): number;
	/** 重置上一次面板的结果，下次打开面板前调用，避免上一个面板的返回值串到这一次。 */
	resetResult(): void;
}

/** 造一个捕获面板组件的假 UI。 */
export function createCapturingUi(): CapturingUi {
	let opened = 0;
	let component: KeyDriven | undefined;
	let lastResult: unknown;
	return {
		/** 执行面板工厂并保存返回的组件，模拟 Pi 打开面板。 */
		async custom(factory: unknown): Promise<undefined> {
			opened += 1;
			const create = factory as (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: unknown) => void,
			) => Component;
			const theme = {
				/** 面板只用到前景色，测试里原样返回文本。 */
				fg: (_color: string, text: string) => text,
				/** 面板只用到加粗，测试里原样返回文本。 */
				bold: (text: string) => text,
			};
			lastResult = undefined;
			component = create(
				{ requestRender: () => undefined },
				theme,
				undefined,
				(result: unknown) => {
					lastResult = result;
				},
			);
			return undefined;
		},
		/** 最近一次打开的面板组件。 */
		component: () => component,
		/** 面板是否被打开过。 */
		opened: () => opened > 0,
		/** 关闭面板时收到的返回值。 */
		result: () => lastResult,
		/** 已经打开过的面板次数。 */
		openCount: () => opened,
		/** 清空上一次面板的结果。 */
		resetResult: () => {
			lastResult = undefined;
		},
	};
}

/** 向组件依次送按键；组件未打开时抛错，避免测试静默变成空操作。 */
export function press(component: KeyDriven | undefined, keys: readonly string[]): void {
	if (!component) throw new Error("面板组件没有打开，无法送按键");
	for (const key of keys) component.handleInput(key);
}

/**
 * 按「每次打开面板时执行一段按键脚本」的方式驱动面板。
 *
 * 面板是分层的：顶层选中 reviewer 会关掉当前面板再开一个字段页，所以按键不能在
 * `ctx.ui.custom` 返回后才发，而是在工厂里就发。脚本用完后之后打开的面板直接不动（保持打开
 * 状态，Esc 由调用方在脚本里发）。
 */
export function createScriptedUi(scripts: readonly (readonly string[])[]): {
	custom(factory: unknown): Promise<unknown>;
	openCount(): number;
} {
	const capture = createCapturingUi();
	let index = 0;
	return {
		/** 执行工厂、立即按下一段脚本送按键，并把 done() 的返回值当作面板结果返回。 */
		async custom(factory: unknown): Promise<unknown> {
			await capture.custom(factory);
			const script = scripts[index];
			index += 1;
			if (script) press(capture.component(), script);
			return capture.result();
		},
		/** 已经打开过的面板次数。 */
		openCount: () => capture.openCount(),
	};
}

/** 按指定次数下移选中项。 */
export function down(times: number): string[] {
	return Array.from({ length: times }, () => DOWN);
}
