/**
 * 清爽模式的配置与运行状态类型。
 *
 * 折叠单位是「一次 agent 运行」（agent_start → agent_settled），不是单个 LLM turn，
 * 因为一次用户提问里的工作过程会跨多个 turn。代码里统一用 run 表示这个单位。
 *
 * 折叠语义：运行过程中"带 tool call 的 assistant 消息"和"工具行"都算工作过程，
 * 折叠时整段隐藏，只留不带 tool call 的那条 assistant 消息作为最终答案。
 * 该判别依据来自 Pi 的 `AssistantMessageComponent.hasToolCalls`。
 *
 * 之所以不需要记录"哪一条是最终答案"：agent 循环在没有 tool call 时结束，
 * 因此一次运行里不带 tool call 的 assistant 消息天然只有最后一条。
 */

export interface CleanModeConfig {
	/** 总开关；关闭后所有 patch 直接放行原始渲染。 */
	enabled: boolean;
	/** 运行中自动展开，运行结束（agent_settled）后自动收起。 */
	autoExpandWhileRunning: boolean;
	/** 折叠时在最终答案上方显示「用时」折叠头。 */
	showRunHeader: boolean;
	/** 折叠头文案里是否附带展开提示。 */
	showExpandHint: boolean;
}

export const DEFAULT_CLEAN_MODE_CONFIG: CleanModeConfig = {
	enabled: true,
	autoExpandWhileRunning: true,
	showRunHeader: true,
	showExpandHint: true,
};

export interface ConfigLoadResult {
	config: CleanModeConfig;
	/** 配置文件存在但不可用时记录原因，便于提示用户。 */
	diagnostic?: string;
}

export interface ConfigSaveResult {
	success: boolean;
	error?: string;
}

/** 渲染决策所需的运行状态快照；与组件实例解耦，便于单测。 */
export interface CleanModeState {
	/** 当前是否处于折叠态。 */
	collapsed: boolean;
	/** 最近一次 agent 运行的耗时（毫秒）；未知时为 undefined。 */
	runDurationMs?: number;
	/** 本次运行是否已结束（agent_settled 之后）。 */
	runSettled: boolean;
	/** 用户本次运行是否手动切换过折叠状态，用于压制自动收起。 */
	userOverrodeThisRun: boolean;
}
