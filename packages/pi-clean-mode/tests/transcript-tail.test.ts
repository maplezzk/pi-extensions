import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTranscriptTail,
	findTranscriptContainer,
	type TranscriptNode,
} from "../src/transcript-tail.ts";

/** 造一个只会输出固定文本的叶子组件。 */
function leaf(text: string): TranscriptNode {
	return { render: () => [text] };
}

/**
 * 假容器：render 定义在原型上，和 pi-tui 的 Container 行为一致。
 *
 * 这一点对补丁的还原路径很重要：原型上的 render 才能用 delete 把实例补丁摘掉。
 */
class FakeContainer implements TranscriptNode {
	/** 子组件，按加入顺序渲染。 */
	children: TranscriptNode[];

	/** 用给定的子组件建一个容器；缺省为空容器。 */
	constructor(children: TranscriptNode[] = []) {
		this.children = children;
	}

	/** 把子组件的行按顺序拼起来。 */
	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/** 造一个容器组件。 */
function box(children: TranscriptNode[]): TranscriptNode {
	return new FakeContainer(children);
}

/** 造一个长得像 assistant 消息的组件；判定只依赖 contentContainer 与 hasToolCalls。 */
function assistantLike(text: string): TranscriptNode {
	/** 判定只用到这两个字段，其余字段与本层无关。 */
	const node: TranscriptNode & { contentContainer: TranscriptNode; hasToolCalls: boolean } = {
		render: () => [text],
		contentContainer: box([leaf(text)]),
		hasToolCalls: false,
	};
	return node;
}

/** 造一棵「TUI → 文档 → chat → 消息」的组件树，返回根与 chat 容器。 */
function createTree(): { root: TranscriptNode; chat: TranscriptNode } {
	const chat = box([assistantLike("用时 21s ›")]);
	const document = box([box([]), chat]);
	const root = box([document, box([])]);
	return { root, chat };
}

test("能找到直接持有 assistant 消息的容器", () => {
	const { root, chat } = createTree();
	assert.equal(findTranscriptContainer(root), chat, "应命中 chat 容器而不是外层包装");
});

test("没有 assistant 消息时找不到容器", () => {
	const root = box([box([leaf("只有普通组件")])]);
	assert.equal(findTranscriptContainer(root), undefined);
	assert.equal(findTranscriptContainer(undefined), undefined);
});

test("挂上补丁后在 transcript 末尾追加行", () => {
	const { root } = createTree();
	const tail = createTranscriptTail({ getRoot: () => root, getLines: () => ["│ ⠹ 运行命令"] });

	assert.equal(tail.attach(), true, "树里已有 assistant 消息，本次应新挂上补丁");
	assert.equal(tail.attach(), false, "已挂上时不重复包装");
	assert.deepEqual(root.render(80), ["用时 21s ›", "│ ⠹ 运行命令"]);
});

test("追加的行每次渲染都重新取，跟着运行状态变化", () => {
	const { root } = createTree();
	let lines = ["│ ⠹ 运行命令"];
	const tail = createTranscriptTail({ getRoot: () => root, getLines: () => lines });
	tail.attach();

	lines = ["│ ⠸ 运行命令 npm run build"];
	assert.deepEqual(root.render(80), ["用时 21s ›", "│ ⠸ 运行命令 npm run build"]);

	lines = [];
	assert.deepEqual(root.render(80), ["用时 21s ›"], "行为空时输出应与原始一致");
});

test("重复 attach 只包一层，行不会叠加", () => {
	const { root } = createTree();
	const tail = createTranscriptTail({ getRoot: () => root, getLines: () => ["│ ⠹ 运行命令"] });

	tail.attach();
	tail.attach();
	assert.deepEqual(root.render(80), ["用时 21s ›", "│ ⠹ 运行命令"]);
});

test("容器还没出现时 attach 返回 false，之后可以补挂", () => {
	const chat = new FakeContainer();
	const root = box([box([chat])]);
	const tail = createTranscriptTail({ getRoot: () => root, getLines: () => ["│ ⠹ 运行命令"] });

	assert.equal(tail.attach(), false, "还没有 assistant 消息时应返回 false");
	chat.children.push(assistantLike("用时 21s ›"));
	assert.equal(tail.attach(), true, "消息出现后应能补挂并报告新挂上");
	assert.deepEqual(root.render(80), ["用时 21s ›", "│ ⠹ 运行命令"]);
});

test("restore 之后不再追加行，也不再占用实例上的 render", () => {
	const { root, chat } = createTree();
	const tail = createTranscriptTail({ getRoot: () => root, getLines: () => ["│ ⠹ 运行命令"] });

	tail.attach();
	assert.equal(Object.hasOwn(chat, "render"), true, "补丁挂在实例上");

	tail.restore();
	assert.equal(Object.hasOwn(chat, "render"), false, "还原后应清掉实例上的 render");
	assert.deepEqual(root.render(80), ["用时 21s ›"]);
});
