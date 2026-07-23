/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 * - Nudges any agent that forgets to call subagent_done after generating
 *
 * auto-exit 历史背景：
 *   早期设计中 PI_SUBAGENT_AUTO_EXIT=1 会让 agent_end 短路退出 — agent 正常结束
 *   turn 时直接写 { type: "done" } 到 .exit sidecar，绕过 subagent_done 工具。
 *   这与 workflow 系统启用 PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA 冲突：LLM 即使
 *   决定不调 subagent_done 也会被短路退出，workflow 永远拿不到 structuredOutput
 *   → "Subagent finished without calling structured_output"。
 *   现在不论 autoExit env 如何，agent 都必须主动调用 subagent_done 或 caller_ping
 *   才能结束。如果 agent 不调，会被 nudge 提醒。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import Ajv from "ajv";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import { createSubagentActivityRecorder } from "./activity.ts";

const i18n = createTranslator(loadCatalog(new URL("../../locales/index.json", import.meta.url)));

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  // ── Agent completion nudge configuration ──
  /** Delay (ms) before sending a nudge after agent_end. Configurable via env var. */
  const NUDGE_DELAY_MS = Math.max(
    1000,
    parseInt(process.env.PI_SUBAGENT_NUDGE_DELAY_MS ?? "5000", 10) || 5000,
  );
  /** Set to "1" to disable the nudge entirely. */
  const NUDGE_DISABLED = process.env.PI_SUBAGENT_NUDGE_DISABLE === "1";

  let doneCalled = false;
  let userInputAfterAgentEnd = false;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearNudgeTimer(): void {
    if (nudgeTimer !== null) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }

  /**
   * After a non-auto-exit subagent finishes generating, schedule a nudge
   * reminding it to call subagent_done if it hasn't already.
   *
   * Each call replaces any pending nudge, so repeated agent_end events
   * (e.g. during multi-turn tool use) automatically reset the timer.
   * The nudge only fires if no new agent activity or user input arrives
   * within NUDGE_DELAY_MS.
   */
  function scheduleAgentEndNudge(): void {
    clearNudgeTimer();
    // 不论 autoExit 是否启用，都必须 nudge — autoExit 已被移除，
    // agent 结束 turn 后只能靠主动调用 subagent_done 才能真正退出。
    if (NUDGE_DISABLED || doneCalled) return;

    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (doneCalled || userInputAfterAgentEnd) return;

      pi.sendUserMessage(
        i18n.t("agentEndNudge"),
        { deliverAs: "followUp" },
      );
    }, NUDGE_DELAY_MS);
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    doneCalled = false;
    userInputAfterAgentEnd = false;
    clearNudgeTimer();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // User typed something — they are in control, cancel any pending nudge.
    userInputAfterAgentEnd = true;
    clearNudgeTimer();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
    // Agent is about to generate — clear any pending nudge; the AI is active.
    clearNudgeTimer();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
    // Agent has started a new generation cycle — clear any pending nudge.
    userInputAfterAgentEnd = false;
    clearNudgeTimer();
  });

  pi.on("agent_end", (event, ctx) => {
    // auto-exit 已彻底移除：agent 必须主动调用 subagent_done 工具才能结束 session。
    // 之前的 autoExit 短路会在 agent 正常结束 turn 时直接写 { type: "done" } 到
    // .exit 文件，绕过 subagent_done 工具。这会让 workflow 系统（启用
    // PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA 时）拿到 undefined 的 structuredOutput
    // → "Subagent finished without calling structured_output"。
    // 现在不论 autoExit env 如何，都不自动退出 — 只能靠 agent 自己调
    // subagent_done（或 caller_ping）。如果 agent 不调，下面会有 nudge 提醒。
    recorder.agentEndWaiting();

    // For non-auto-exit agents: schedule a nudge in case the AI forgot to call
    // subagent_done. This is automatically cleared/reset on any subsequent
    // agent activity or user input.
    scheduleAgentEndNudge();
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    clearNudgeTimer();
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      doneCalled = true;
      clearNudgeTimer();
      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      try {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));
      } catch (writeErr: any) {
        process.stderr.write(
          `[subagent-done] caller_ping: .exit 写入失败 file=${sessionFile}.exit err=${writeErr?.message ?? String(writeErr)}\n`,
        );
      }

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  // ── subagent_done ──
  // When PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA is set, the `result` parameter
  // is required and ajv-validated against the JSON Schema before writing to
  // the .exit sidecar. Otherwise `result` is optional — the subagent's last
  // assistant message is used as the summary.
  (() => {
    let structuredOutputSchema: object | null = null;
    try {
      const raw = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
      if (raw) structuredOutputSchema = JSON.parse(raw);
    } catch {
      // Schema parse failure — result will be optional.
    }

    const hasSchema = !!structuredOutputSchema;
    let validate: ReturnType<Ajv["compile"]> | null = null;
    if (hasSchema) {
      const ajv = new Ajv({ allErrors: true });
      validate = ajv.compile(structuredOutputSchema!);
    }

    // result 的类型直接用真实 schema（Type.Unsafe 透传 JSON Schema），让 AI 看到
    // 完整的 properties/required。旧实现用空 Type.Object 占位 + 把 schema 藏在
    // description 文本里，导致 AI 不知道要把字段包进 result，直接放到顶层参数。
    const resultParam = hasSchema
      ? Type.Unsafe({
          ...(structuredOutputSchema as object),
          description:
            `Required structured result. Must match this JSON Schema:\n` +
            JSON.stringify(structuredOutputSchema, null, 2),
        })
      : Type.Optional(
          Type.Any({
            description:
              "Optional structured result for the parent session. Pass your structured output here.",
          }),
        );

    const descriptionBase =
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session.";
    const description = hasSchema
      ? `${descriptionBase} You MUST pass your final output as the \`result\` argument — it will be validated against a JSON Schema. If validation fails you will see the errors and can retry.`
      : `${descriptionBase} Your LAST assistant message before calling this becomes the summary returned to the caller.`;

    pi.registerTool({
      name: "subagent_done",
      label: "Subagent Done",
      description,
      parameters: Type.Object({ result: resultParam }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionFile = process.env.PI_SUBAGENT_SESSION;

        // Validate structured result if schema is active
        if (hasSchema) {
          if (!params.result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Validation failed — `result` is required for this task. Pass your structured output as the `result` argument.",
                },
              ],
              details: { error: "validation_failed", errors: [{ message: "result is required" }] },
            };
          }
          if (validate && !validate(params.result)) {
            const errors = (validate.errors ?? [])
              .map((e) => `  - ${e.instancePath || "/"}: ${e.message}`)
              .join("\n");
            return {
              content: [
                {
                  type: "text",
                  text: `Validation failed — your \`result\` does not match the required schema:\n${errors}\n\nFix your arguments and call subagent_done again.`,
                },
              ],
              details: { error: "validation_failed", errors: validate.errors },
            };
          }
        }

        doneCalled = true;
        clearNudgeTimer();
        recorder.subagentDone();

        if (sessionFile) {
          const exitFile = `${sessionFile}.exit`;
          try {
            if (params.result) {
              writeFileSync(exitFile, JSON.stringify({ type: "structured_output", value: params.result }));
            } else {
              writeFileSync(exitFile, JSON.stringify({ type: "done" }));
            }
          } catch (writeErr: any) {
            process.stderr.write(
              `[subagent-done] subagent_done: .exit 写入失败 file=${exitFile} err=${writeErr?.message ?? String(writeErr)}\n`,
            );
          }
        }

        ctx.shutdown();
        return {
          content: [{ type: "text", text: "Shutting down subagent session." }],
          details: params.result ?? {},
        };
      },
    });
  })();
}
