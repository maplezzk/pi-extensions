import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseToggleValue,
	withActivityRows,
	withBooleanConfigField,
} from "../src/config-fields.ts";
import { ACTIVITY_ROWS_RANGE, DEFAULT_CLEAN_MODE_CONFIG } from "../src/types.ts";

/** 全部布尔配置字段，写回测试逐个覆盖。 */
const BOOLEAN_KEYS = [
	"enabled",
	"autoExpandWhileRunning",
	"showRunHeader",
	"enableActionGroups",
	"showActivityArea",
	"animateActivity",
	"hideThinking",
] as const;

test("parseToggleValue 认常见的开关写法，忽略大小写与空白", () => {
	for (const raw of ["on", "ON", " true ", "1", "yes"]) {
		assert.equal(parseToggleValue(raw), true, `${raw} 应解析为打开`);
	}
	for (const raw of ["off", "OFF", " false ", "0", "no"]) {
		assert.equal(parseToggleValue(raw), false, `${raw} 应解析为关闭`);
	}
	assert.equal(parseToggleValue("maybe"), undefined);
	assert.equal(parseToggleValue(""), undefined);
});

test("withBooleanConfigField 能写回每一个布尔字段", () => {
	for (const key of BOOLEAN_KEYS) {
		const base = { ...DEFAULT_CLEAN_MODE_CONFIG, [key]: true };
		const next = withBooleanConfigField(base, key, false);
		assert.equal(next?.[key], false, `${key} 应被写成 false`);
		// 其它字段不能被顺手改掉。
		assert.deepEqual(next, { ...base, [key]: false });
	}
});

test("withBooleanConfigField 拒绝未知字段与 activityRows", () => {
	assert.equal(withBooleanConfigField(DEFAULT_CLEAN_MODE_CONFIG, "nope", true), undefined);
	// 行数是数字字段，不能被布尔写入路径改坏。
	assert.equal(withBooleanConfigField(DEFAULT_CLEAN_MODE_CONFIG, "activityRows", true), undefined);
});

test("withActivityRows 只接受区间内的整数", () => {
	for (let rows = ACTIVITY_ROWS_RANGE.min; rows <= ACTIVITY_ROWS_RANGE.max; rows += 1) {
		assert.equal(withActivityRows(DEFAULT_CLEAN_MODE_CONFIG, rows)?.activityRows, rows);
	}
	assert.equal(withActivityRows(DEFAULT_CLEAN_MODE_CONFIG, ACTIVITY_ROWS_RANGE.min - 1), undefined);
	assert.equal(withActivityRows(DEFAULT_CLEAN_MODE_CONFIG, ACTIVITY_ROWS_RANGE.max + 1), undefined);
	assert.equal(withActivityRows(DEFAULT_CLEAN_MODE_CONFIG, 2.5), undefined);
	assert.equal(withActivityRows(DEFAULT_CLEAN_MODE_CONFIG, Number.NaN), undefined);
});
