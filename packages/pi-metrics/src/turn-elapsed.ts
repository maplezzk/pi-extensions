/**
 * Pi turn 耗时显示插件
 *
 * - working 期间：实时更新 spinner 文字，显示从用户发出消息起的全程耗时（如 "⏱ 47s"），
 *   跨轮不归零 —— 用户等待时最关心的是"一共等了多久"
 * - agent 完全停止时（agent_settled）：插入一条总耗时，覆盖从用户发出消息到 AI 停止
 *   的整段过程（跨越多轮工具调用、自动重试和 compaction 续跑）
 *
 * 关于「本轮耗时」：它已经包含在 tps 的那条指标提示里（TPS/TTFT/耗时/tokens 一行），
 * 所以这里不再单独发一条，避免同一轮冒两条指标提示。
 * 只有整段运行超过一轮时才发总耗时：单轮运行的总耗时只比本轮多一点收尾开销，是噪声。
 *
 * 设计取舍：
 * - 用 setWorkingMessage 改 spinner 文字会覆盖 pi 默认的 "Working... (Esc to interrupt)"。
 *   为了让耗时最显眼，接受这个 trade-off —— 用户更关心"等了多久"而非"怎么中断"。
 * - 总耗时起点用 input 事件（用户真正发出消息的时刻），而不是 agent_start（略晚）。
 *   运行中收到的 steer/followUp 消息不重置起点：整段连续工作计入同一次总耗时。
 * - 总耗时终点用 agent_settled 而不是 agent_end：agent_end 之后还可能发生自动重试、
 *   compaction 和队列续跑，agent_settled 才表示 AI 真正停下（Esc 中断也会在 finally 中触发）。
 * - 非 TUI 模式（rpc / print）下 hasUI 为 false，不启动定时器、不发 notify。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyWithSource } from "pi-extensions-i18n";
import { formatDone, formatTick } from "./format-utils.ts";
import { i18n } from "./i18n.ts";
import { NOTICE_SOURCE } from "./notice.ts";

const TICK_MS = 1000;

/** 至少跑满两轮才值得单独报一次总耗时；单轮的总耗时是噪声。 */
const MIN_TURNS_FOR_TOTAL = 2;

/** 计时状态：与 Pi 事件解耦，便于直接测试判定规则。 */
export interface ElapsedTracker {
  /** 用户发出消息（或没有 input 事件时的兜底）开始记一段运行；运行中重复调用不改起点。 */
  startRun(): void;
  /** 本段运行的已耗时（毫秒）；没有进行中的运行时返回 0。 */
  runElapsed(): number;
  /** 标记本轮已开始（只用计轮数，不再单独算本轮耗时）。 */
  startTurn(): void;
  /** 一轮结束：累计轮次并清掉本轮状态。 */
  endTurn(): void;
  /** AI 停下：跑满两轮时返回本段总耗时（毫秒），否则返回 undefined。 */
  settle(): number | undefined;
  /** 清掉本轮起点（agent_end 用）。 */
  clearTurn(): void;
}

/** 造一个计时状态；now 可注入，便于测试确定性地推进时间。 */
export function createElapsedTracker(now: () => number = () => Date.now()): ElapsedTracker {
  /** 是否已开始一段运行；不用时间戳做哨兵，时钟可以从 0 开始。 */
  let running = false;
  /** 本段运行起点（毫秒）。 */
  let runStartTime = 0;
  /** 当前轮是否已开始。 */
  let inTurn = false;
  /** 本段运行已跑完的轮数。 */
  let turnCount = 0;
  return {
    /** 开始记一段运行；运行中重复调用不改起点。 */
    startRun(): void {
      if (running) return;
      running = true;
      runStartTime = now();
      turnCount = 0;
    },
    /** 本段运行的已耗时（毫秒）；没有进行中的运行时返回 0。 */
    runElapsed(): number {
      return running ? now() - runStartTime : 0;
    },
    /** 标记本轮已开始（只用计轮数）。 */
    startTurn(): void {
      inTurn = true;
    },
    /** 一轮结束：累计轮次并清掉本轮状态。 */
    endTurn(): void {
      if (inTurn) turnCount += 1;
      inTurn = false;
    },
    /** AI 停下：跑满两轮时返回本段总耗时（毫秒），否则返回 undefined。 */
    settle(): number | undefined {
      const elapsed = running ? now() - runStartTime : 0;
      const turns = turnCount;
      running = false;
      inTurn = false;
      runStartTime = 0;
      turnCount = 0;
      return elapsed > 0 && turns >= MIN_TURNS_FOR_TOTAL ? elapsed : undefined;
    },
    /** 清掉本轮状态（agent_end 用）。 */
    clearTurn(): void {
      inTurn = false;
    },
  };
}

export default function (pi: ExtensionAPI) {
  const tracker = createElapsedTracker();
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  const stopTick = () => {
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  };

  pi.on("input", async (event) => {
    // 只在空闲时收到用户消息才记总耗时起点；运行中的 steer/followUp 保留原起点
    if (event.source === "interactive" || event.source === "rpc") tracker.startRun();
  });

  pi.on("agent_start", async () => {
    // 兜底：extension 注入消息触发的运行没有用户 input 事件
    tracker.startRun();
  });

  pi.on("turn_start", async (_event, ctx) => {
    stopTick();
    tracker.startTurn();
    if (!ctx.hasUI) return;

    const tick = () => {
      // spinner 显示全程总耗时（从用户发出消息起），跨轮不归零
      const elapsed = tracker.runElapsed();
      if (elapsed <= 0) return;
      ctx.ui.setWorkingMessage(i18n.t("elapsedWorking", { value: formatTick(elapsed) }));
    };
    tick();
    tickHandle = setInterval(tick, TICK_MS);
  });

  pi.on("turn_end", async (_event, ctx) => {
    stopTick();
    tracker.endTurn();
    if (!ctx.hasUI) return;

    // 恢复 pi 默认 working 文字（下次 streaming 由 pi 内部重置）；
    // 本轮耗时由 tps 那条指标提示带上，不在这里重复发。
    ctx.ui.setWorkingMessage(undefined);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopTick();
    tracker.clearTurn();
    if (!ctx.hasUI) return;
    ctx.ui.setWorkingMessage(undefined);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    stopTick();
    const runElapsed = tracker.settle();
    if (!ctx.hasUI) return;

    ctx.ui.setWorkingMessage(undefined);
    if (runElapsed !== undefined) {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("elapsedTotal", { value: formatDone(runElapsed) }) });
    }
  });
}
