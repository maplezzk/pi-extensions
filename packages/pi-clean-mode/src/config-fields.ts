/**
 * 可写配置字段的统一入口。
 *
 * 命令（`/config:clean-mode key=on`）与 TUI 配置面板都从这里改配置，
 * 新增字段只改这一处，避免两条路径各写一份写回逻辑而漏字段。
 */

import { ACTIVITY_ROWS_RANGE, type CleanModeConfig } from "./types.js";

/** 表示「打开」的取值。 */
const ON_VALUES = new Set(["on", "true", "1", "yes"]);
/** 表示「关闭」的取值。 */
const OFF_VALUES = new Set(["off", "false", "0", "no"]);

/** 布尔配置项的字段名；写回表与面板都以此为准。 */
export type BooleanConfigKey =
	| "enabled"
	| "autoExpandWhileRunning"
	| "showRunHeader"
	| "enableActionGroups"
	| "showActivityArea"
	| "animateActivity"
	| "hideThinking";

/** 布尔配置项 -> 写回函数；新增布尔字段只改这张表。 */
const BOOLEAN_FIELD_WRITERS: Record<
	BooleanConfigKey,
	(config: CleanModeConfig, value: boolean) => CleanModeConfig
> = {
	// 总开关。
	enabled: (config, value) => ({ ...config, enabled: value }),
	// 运行中自动展开。
	autoExpandWhileRunning: (config, value) => ({ ...config, autoExpandWhileRunning: value }),
	// 折叠时显示「用时」折叠头。
	showRunHeader: (config, value) => ({ ...config, showRunHeader: value }),
	// 同一轮的多条工具调用收成一行组头。
	enableActionGroups: (config, value) => ({ ...config, enableActionGroups: value }),
	// 轮首实时活动区。
	showActivityArea: (config, value) => ({ ...config, showActivityArea: value }),
	// 活动区动画。
	animateActivity: (config, value) => ({ ...config, animateActivity: value }),
	// 收起 Pi 的 thinking 块。
	hideThinking: (config, value) => ({ ...config, hideThinking: value }),
};

/** 把配置值文本解析成布尔；无法识别时返回 undefined。 */
export function parseToggleValue(raw: string): boolean | undefined {
	const normalized = raw.trim().toLowerCase();
	if (ON_VALUES.has(normalized)) {
		return true;
	}
	if (OFF_VALUES.has(normalized)) {
		return false;
	}
	return undefined;
}

/** 字段名是否是已知的布尔配置项。 */
function isBooleanConfigKey(key: string): key is BooleanConfigKey {
	return Object.hasOwn(BOOLEAN_FIELD_WRITERS, key);
}

/** 按字段名写回一个布尔配置项；字段名不受支持时返回 undefined。 */
export function withBooleanConfigField(
	config: CleanModeConfig,
	key: string,
	value: boolean,
): CleanModeConfig | undefined {
	if (!isBooleanConfigKey(key)) {
		return undefined;
	}
	return BOOLEAN_FIELD_WRITERS[key](config, value);
}

/** 写回活动区行数；非整数或超出 1-6 时返回 undefined，不写坏配置。 */
export function withActivityRows(config: CleanModeConfig, value: number): CleanModeConfig | undefined {
	if (!Number.isInteger(value) || value < ACTIVITY_ROWS_RANGE.min || value > ACTIVITY_ROWS_RANGE.max) {
		return undefined;
	}
	return { ...config, activityRows: value };
}
