/**
 * transcript 末尾的补丁层：把实时活动行内联进对话流。
 *
 * 为什么不用 Pi 的 widget：widget 只能挂在编辑器上方或下方，位置固定、不随
 * transcript 滚动，于是看起来像「钉在底部的一条状态」。Codex 的实时活动行长在
 * 对话流末尾，跟着内容一起滚，所以这里改成往 transcript 容器的 render 结果尾部
 * 追加行，行内容由调用方每次渲染时实时给出。
 *
 * transcript 容器靠遍历组件树定位：它是唯一直接持有 assistant 消息组件的容器。
 * 判定用鸭子类型（contentContainer + hasToolCalls）而不是 instanceof —— 扩展与
 * Pi 可能各自加载一份 pi-tui / pi-coding-agent，跨副本的模块实例未必相同。
 */

import { debugLog } from "./debug-logger.js";

/** 调试日志作用域：transcript 末尾补丁。 */
const DEBUG_SCOPE = "transcript tail";
/** 连续多少次找不到 transcript 容器后才写一条日志。 */
const MISSING_REPORT_THRESHOLD = 8;

/** 组件树遍历只需要用到的两个成员。 */
export interface TranscriptNode {
	/** 组件渲染入口。 */
	render(width: number): string[];
	/** 容器型组件持有的子组件；叶子组件没有这个字段。 */
	children?: TranscriptNode[];
}

/** 定位与追加所需的外部输入。 */
export interface TranscriptTailDeps {
	/** 取得 TUI 根组件；还没拿到句柄时返回 undefined。 */
	getRoot: () => TranscriptNode | undefined;
	/** 当前要追加到末尾的行；空数组表示不追加。 */
	getLines: () => string[];
}

/** transcript 末尾补丁的生命周期。 */
export interface TranscriptTail {
	/**
	 * 确保补丁已挂上 transcript 容器。
	 *
	 * 返回本次调用是否**新**挂上了补丁（已挂过或还没找到容器都返回 false），
	 * 调用方靠它决定要不要立刻补一次重绘。
	 */
	attach(): boolean;
	/** 还原补丁；未挂载时是空操作。 */
	restore(): void;
}

/** 组件树最大遍历深度，防止异常结构导致无限递归。 */
const MAX_TREE_DEPTH = 16;

/** 判断一个组件是否长得像 assistant 消息组件。 */
function isAssistantMessageLike(node: TranscriptNode): boolean {
	const record = node as unknown as Record<string, unknown>;
	return "contentContainer" in record && "hasToolCalls" in record;
}

/** 该容器是否直接持有 assistant 消息组件。 */
function hasAssistantChild(node: TranscriptNode): boolean {
	const children = node.children;
	return Array.isArray(children) && children.some((child) => isAssistantMessageLike(child));
}

/**
 * 从组件树里找出 transcript 容器。
 *
 * 返回第一个「直接持有 assistant 消息组件」的容器；找不到时返回 undefined。
 * 已经访问过的组件会被跳过，同一组件被多处引用时不会重复展开。
 */
export function findTranscriptContainer(
	root: TranscriptNode | undefined,
): TranscriptNode | undefined {
	const visited = new Set<TranscriptNode>();

	const walk = (node: TranscriptNode, depth: number): TranscriptNode | undefined => {
		if (depth > MAX_TREE_DEPTH || visited.has(node)) {
			return undefined;
		}
		visited.add(node);

		if (hasAssistantChild(node)) {
			return node;
		}

		for (const child of node.children ?? []) {
			const found = walk(child, depth + 1);
			if (found) {
				return found;
			}
		}
		return undefined;
	};

	return root ? walk(root, 0) : undefined;
}

/** 已挂上的补丁；还原时需要原始方法引用。 */
interface RenderPatch {
	container: TranscriptNode;
	/** 补丁前的 render 引用，通常来自原型。 */
	original: (width: number) => string[];
	/** 补丁前该实例是否已有自己的 render；决定还原时是删除还是写回。 */
	hadOwnRender: boolean;
}

/** 创建 transcript 末尾补丁。 */
export function createTranscriptTail(deps: TranscriptTailDeps): TranscriptTail {
	let patch: RenderPatch | undefined;
	/** 连续找不到 transcript 容器的次数，用于区分「刚启动还没消息」与「结构变了」。 */
	let missingStreak = 0;

	const restore = (): void => {
		if (!patch) {
			return;
		}
		if (patch.hadOwnRender) {
			patch.container.render = patch.original;
		} else {
			Reflect.deleteProperty(patch.container, "render");
		}
		patch = undefined;
	};

	return {
		/**
		 * 定位 transcript 容器并在它的 render 尾部追加行。
		 *
		 * 已挂上时直接返回 false；容器尚未出现（例如会话刚启动、还没有 assistant
		 * 消息）时也返回 false，由调用方在下一次刷新时重试。
		 */
		attach: () => {
			if (patch) {
				return false;
			}

			const container = findTranscriptContainer(deps.getRoot());
			if (!container) {
				// 运行刚开始时 assistant 消息还没出现，找不到几次是正常的；连续多次
				// 才说明组件结构与预期不符，这时活动行会一直不显示，必须能查出来。
				missingStreak += 1;
				if (missingStreak === MISSING_REPORT_THRESHOLD) {
					debugLog(DEBUG_SCOPE, "transcript container not found; activity lines stay hidden");
				}
				return false;
			}
			missingStreak = 0;

			const original = container.render;
			const hadOwnRender = Object.hasOwn(container, "render");

			// 只在实例上接管 render：扩展与 Pi 可能各自加载一份 pi-tui，
			// 打原型补丁未必命中的是同一份实现。
			container.render = function patchedTranscriptRender(
				this: TranscriptNode,
				width: number,
			): string[] {
				const lines = original.call(this, width);
				const tail = deps.getLines();
				return tail.length === 0 ? lines : [...lines, ...tail];
			};

			patch = { container, original, hadOwnRender };
			return true;
		},
		restore,
	};
}
