/**
 * Pi turn 耗时显示插件
 *
 * - working 期间：实时更新 spinner 文字，显示从用户发出消息起的全程耗时（如 "⏱ 47s"），
 *   跨轮不归零 —— 用户等待时最关心的是"一共等了多久"
 * - turn 结束时：在 chat 流插入一条 dim 灰文本，提示本轮耗时（如 "✓ 本轮耗时 12.3s"）
 * - agent 完全停止时（agent_settled）：再插入一条总耗时，覆盖从用户发出消息到 AI 停止
 *   的整段过程（跨越多轮工具调用、自动重试和 compaction 续跑）
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
import { formatDone, formatTick } from "./format-utils.ts";
import { i18n } from "./i18n.ts";

const TICK_MS = 1000;

export default function (pi: ExtensionAPI) {
  let turnStartTime = 0;
  let runStartTime = 0;
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  const stopTick = () => {
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  };

  pi.on("input", async (event) => {
    // 只在空闲时收到用户消息才记总耗时起点；运行中的 steer/followUp 保留原起点
    if (runStartTime === 0 && (event.source === "interactive" || event.source === "rpc")) {
      runStartTime = Date.now();
    }
  });

  pi.on("agent_start", async () => {
    // 兜底：extension 注入消息触发的运行没有用户 input 事件
    if (runStartTime === 0) runStartTime = Date.now();
  });

  pi.on("turn_start", async (event, ctx) => {
    stopTick();
    // 优先用事件自带的时间戳，避免 handler 调度延迟
    turnStartTime = event.timestamp || Date.now();
    if (!ctx.hasUI) return;

    const tick = () => {
      // spinner 显示全程总耗时（从用户发出消息起），跨轮不归零；
      // runStartTime 尚未记录时（理论上不会）退化为本轮起点
      const base = runStartTime || turnStartTime;
      if (!base) return;
      ctx.ui.setWorkingMessage(i18n.t("elapsedWorking", { value: formatTick(Date.now() - base) }));
    };
    tick();
    tickHandle = setInterval(tick, TICK_MS);
  });

  pi.on("turn_end", async (_event, ctx) => {
    stopTick();
    if (!turnStartTime) return;
    const elapsed = Date.now() - turnStartTime;
    turnStartTime = 0;
    if (!ctx.hasUI) return;

    // 恢复 pi 默认 working 文字（下次 streaming 由 pi 内部重置）
    ctx.ui.setWorkingMessage(undefined);
    // 在 chat 流末尾插入一条 dim 灰文本
    ctx.ui.notify(i18n.t("elapsedDone", { value: formatDone(elapsed) }), "info");
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopTick();
    turnStartTime = 0;
    if (!ctx.hasUI) return;
    ctx.ui.setWorkingMessage(undefined);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    stopTick();
    const runElapsed = runStartTime ? Date.now() - runStartTime : 0;
    runStartTime = 0;
    turnStartTime = 0;
    if (!ctx.hasUI) return;

    ctx.ui.setWorkingMessage(undefined);
    if (runElapsed > 0) {
      ctx.ui.notify(i18n.t("elapsedTotal", { value: formatDone(runElapsed) }), "info");
    }
  });
}
