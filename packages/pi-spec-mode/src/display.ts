import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type SpecProgressState = "done" | "active" | "waiting" | "queued";

export interface SpecProgressRow {
  label: string;
  state: SpecProgressState;
  detail?: string;
}

export interface SpecProgressSnapshot {
  name: string;
  profile: string;
  status: string;
  rows: SpecProgressRow[];
  currentTask?: string;
}

export interface SpecProgressTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const MIN_RENDER_WIDTH = 4;
const MIN_CONTENT_WIDTH = 1;
const BORDER_WIDTH = 2;
const TITLE_FILL_RESERVE = 1;

/** 根据阶段状态返回与 Workflow UI 一致的符号和主题色。 */
function progressIcon(
  state: SpecProgressState,
  theme: SpecProgressTheme,
): string {
  switch (state) {
    case "done":
      return theme.fg("success", "✓");
    case "active":
      return theme.fg("accent", "▶");
    case "waiting":
      return theme.fg("warning", "◆");
    case "queued":
      return theme.fg("dim", "○");
  }
}

/** 将一行 ANSI 文本截断并补齐到边框内部宽度。 */
function padInside(
  content: string,
  innerWidth: number,
  theme: SpecProgressTheme,
): string {
  const clipped = truncateToWidth(content, innerWidth, "");
  const padding = Math.max(0, innerWidth - visibleWidth(clipped));
  return `${theme.fg("borderAccent", "│")}${clipped}${" ".repeat(padding)}${theme.fg("borderAccent", "│")}`;
}

/**
 * 渲染 Workflow 风格的阶段进度 Widget。
 * 每行可见宽度严格不超过 width，兼容 CJK 双宽字符与 ANSI 色彩。
 */
export function renderSpecProgressLines(
  snapshot: SpecProgressSnapshot,
  theme: SpecProgressTheme,
  width: number,
): string[] {
  if (width < MIN_RENDER_WIDTH) {
    return [truncateToWidth(snapshot.name, Math.max(MIN_CONTENT_WIDTH, width), "")];
  }

  const boxWidth = width;
  const innerWidth = boxWidth - BORDER_WIDTH;
  const rawTitle = ` Spec: ${snapshot.name} · ${snapshot.profile} `;
  const title = truncateToWidth(
    rawTitle,
    Math.max(MIN_CONTENT_WIDTH, innerWidth - TITLE_FILL_RESERVE),
    "",
  );
  const titleWidth = visibleWidth(title);
  const titleFill = Math.max(0, innerWidth - titleWidth);
  const top =
    theme.fg("borderAccent", "╭") +
    theme.fg("toolTitle", theme.bold(title)) +
    theme.fg("borderAccent", `${"─".repeat(titleFill)}╮`);

  const lines = [top];
  for (const row of snapshot.rows) {
    const icon = progressIcon(row.state, theme);
    const labelColor = row.state === "queued" ? "dim" : "toolOutput";
    const label = theme.fg(labelColor, row.label);
    const detail = row.detail ? theme.fg("muted", ` · ${row.detail}`) : "";
    lines.push(padInside(`  ${icon} ${label}${detail}`, innerWidth, theme));
  }

  if (snapshot.currentTask) {
    lines.push(
      padInside(
        `    ${theme.fg("accent", "#")} ${theme.fg("toolOutput", snapshot.currentTask)}`,
        innerWidth,
        theme,
      ),
    );
  }

  lines.push(
    padInside(
      `  ${theme.fg("dim", snapshot.status)}`,
      innerWidth,
      theme,
    ),
  );
  lines.push(
    theme.fg("borderAccent", `╰${"─".repeat(boxWidth - BORDER_WIDTH)}╯`),
  );
  return lines;
}

/** RPC/非 TUI 模式的无 ANSI 文本版本。 */
export function renderSpecProgressText(
  snapshot: SpecProgressSnapshot,
): string[] {
  const icons: Record<SpecProgressState, string> = {
    done: "✓",
    active: "▶",
    waiting: "◆",
    queued: "○",
  };
  const lines = [`◆ Spec: ${snapshot.name} · ${snapshot.profile}`];
  for (const row of snapshot.rows) {
    lines.push(
      `  ${icons[row.state]} ${row.label}${row.detail ? ` · ${row.detail}` : ""}`,
    );
  }
  if (snapshot.currentTask) lines.push(`    # ${snapshot.currentTask}`);
  lines.push(`  ${snapshot.status}`);
  return lines;
}
