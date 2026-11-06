import { z } from "zod";

/**
 * Standard component definitions for the Pi terminal catalog.
 *
 * Component names, prop names, and prop value vocabularies intentionally match
 * `@json-render/ink`'s standard catalog so a spec written for Ink also
 * validates here. Props are declared `.nullable().optional()` instead of Ink's
 * "required but nullable": that is a strict superset, so every Ink-valid spec
 * stays valid while the model is not forced to emit explicit `null`s.
 */
export const standardComponentDefinitions = {
  // ==========================================================================
  // Layout
  // ==========================================================================

  Box: {
    props: z.object({
      flexDirection: z.enum(["row", "row-reverse", "column", "column-reverse"]).nullable().optional(),
      alignItems: z.enum(["flex-start", "center", "flex-end", "stretch"]).nullable().optional(),
      justifyContent: z
        .enum(["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"])
        .nullable()
        .optional(),
      flexGrow: z.number().nullable().optional(),
      flexShrink: z.number().nullable().optional(),
      flexWrap: z.enum(["nowrap", "wrap", "wrap-reverse"]).nullable().optional(),
      width: z.union([z.number().max(500), z.string()]).nullable().optional(),
      height: z.union([z.number().max(500), z.string()]).nullable().optional(),
      minWidth: z.union([z.number().max(500), z.string()]).nullable().optional(),
      minHeight: z.union([z.number().max(500), z.string()]).nullable().optional(),
      padding: z.number().nullable().optional(),
      paddingX: z.number().nullable().optional(),
      paddingY: z.number().nullable().optional(),
      paddingTop: z.number().nullable().optional(),
      paddingBottom: z.number().nullable().optional(),
      paddingLeft: z.number().nullable().optional(),
      paddingRight: z.number().nullable().optional(),
      margin: z.number().nullable().optional(),
      marginX: z.number().nullable().optional(),
      marginY: z.number().nullable().optional(),
      marginTop: z.number().nullable().optional(),
      marginBottom: z.number().nullable().optional(),
      marginLeft: z.number().nullable().optional(),
      marginRight: z.number().nullable().optional(),
      gap: z.number().nullable().optional(),
      columnGap: z.number().nullable().optional(),
      rowGap: z.number().nullable().optional(),
      borderStyle: z
        .enum(["single", "double", "round", "bold", "singleDouble", "doubleSingle", "classic"])
        .nullable()
        .optional(),
      borderColor: z.string().nullable().optional(),
      borderTop: z.boolean().nullable().optional(),
      borderBottom: z.boolean().nullable().optional(),
      borderLeft: z.boolean().nullable().optional(),
      borderRight: z.boolean().nullable().optional(),
      borderDimColor: z.boolean().nullable().optional(),
      display: z.enum(["flex", "none"]).nullable().optional(),
      overflow: z.enum(["visible", "hidden"]).nullable().optional(),
      backgroundColor: z.string().nullable().optional(),
    }),
    slots: ["default"],
    description:
      "Layout container (like a terminal <div>). Use for grouping, spacing, borders, and alignment. Default flexDirection is row.",
    example: { flexDirection: "column", padding: 1, gap: 1, borderStyle: "round" },
  },

  Text: {
    props: z.object({
      text: z.string(),
      color: z.string().nullable().optional(),
      backgroundColor: z.string().nullable().optional(),
      bold: z.boolean().nullable().optional(),
      italic: z.boolean().nullable().optional(),
      underline: z.boolean().nullable().optional(),
      strikethrough: z.boolean().nullable().optional(),
      dimColor: z.boolean().nullable().optional(),
      inverse: z.boolean().nullable().optional(),
      wrap: z
        .enum(["wrap", "truncate", "truncate-end", "truncate-middle", "truncate-start"])
        .nullable()
        .optional(),
    }),
    slots: [],
    description:
      "Text output with optional styling (color, bold, italic, etc.). Use for all text content in the terminal.",
    example: { text: "Hello, world!", bold: true, color: "green" },
  },

  Newline: {
    props: z.object({
      count: z.number().nullable().optional(),
    }),
    slots: [],
    description: "Inserts one or more blank lines. Only meaningful inside a Box with flexDirection column.",
    example: { count: 1 },
  },

  Spacer: {
    props: z.object({}),
    slots: [],
    description:
      "Flexible empty space that expands to fill available room. Use between elements in a horizontal row to push them apart.",
    example: {},
  },

  // ==========================================================================
  // Content
  // ==========================================================================

  Heading: {
    props: z.object({
      text: z.string(),
      level: z.enum(["h1", "h2", "h3", "h4"]).nullable().optional(),
      color: z.string().nullable().optional(),
    }),
    slots: [],
    description: "Section heading. h1 is bold, h2 is bold, h3 is dimmed and bold, h4 is dimmed.",
    example: { text: "Dashboard", level: "h1" },
  },

  Divider: {
    props: z.object({
      character: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      dimColor: z.boolean().nullable().optional(),
      title: z.string().nullable().optional(),
      width: z.number().max(500).nullable().optional(),
    }),
    slots: [],
    description:
      "Horizontal separator line. Default width fills the available space, capped at 40 columns. Optionally centered title.",
    example: { title: "Section", color: "gray" },
  },

  Badge: {
    props: z.object({
      label: z.string(),
      variant: z.enum(["default", "info", "success", "warning", "error"]).nullable().optional(),
    }),
    slots: [],
    description: "Small colored inline label for status, counts, and categories.",
    example: { label: "ACTIVE", variant: "success" },
  },

  Spinner: {
    props: z.object({
      label: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
    }),
    slots: [],
    description:
      "Animated loading spinner with optional label text. Animates only while the tool call is still running; it freezes on the first frame afterwards.",
    example: { label: "Loading...", color: "cyan" },
  },

  ProgressBar: {
    props: z.object({
      progress: z.number(),
      width: z.number().max(500).nullable().optional(),
      color: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
    }),
    slots: [],
    description:
      "Horizontal progress bar. Set progress from 0 to 1. Default width is 30 characters.",
    example: { progress: 0.65, width: 30, color: "green", label: "Uploading" },
  },

  Sparkline: {
    props: z.object({
      data: z.array(z.number()),
      width: z.number().max(500).nullable().optional(),
      color: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
    }),
    slots: [],
    description:
      "Inline sparkline chart using Unicode block characters. Pass an array of numbers to visualize trends compactly. Set min/max to fix the scale across multiple sparklines.",
    example: { data: [3, 7, 2, 9, 4, 8, 1, 6, 5], color: "cyan", label: "CPU" },
  },

  BarChart: {
    props: z.object({
      data: z.array(
        z.object({
          label: z.string(),
          value: z.number(),
          color: z.string().nullable().optional(),
        }),
      ),
      width: z.number().max(500).nullable().optional(),
      showValues: z.boolean().nullable().optional(),
      showPercentage: z.boolean().nullable().optional(),
    }),
    slots: [],
    description:
      "Horizontal bar chart. Each item has a label, numeric value, and optional color. Set showValues to display raw numbers, showPercentage to show % of total. Default bar width is 30.",
    example: {
      data: [
        { label: "TypeScript", value: 65, color: "blue" },
        { label: "Python", value: 20, color: "yellow" },
        { label: "Rust", value: 15, color: "red" },
      ],
      showPercentage: true,
    },
  },

  Table: {
    props: z.object({
      columns: z.array(
        z.object({
          header: z.string(),
          key: z.string(),
          width: z.number().max(200).nullable().optional(),
          align: z.enum(["left", "center", "right"]).nullable().optional(),
        }),
      ),
      rows: z.array(z.record(z.string(), z.string())),
      borderStyle: z.enum(["single", "double", "round", "bold", "classic"]).nullable().optional(),
      backgroundColor: z.string().nullable().optional(),
      headerColor: z.string().nullable().optional(),
    }),
    slots: [],
    description:
      "Tabular data display with headers and rows. Each row is a record mapping column keys to string values. Column widths are computed from the terminal width; the `width` hint sets a preferred cell width.",
    example: {
      columns: [
        { header: "Name", key: "name", width: 20 },
        { header: "Status", key: "status", width: 10 },
      ],
      rows: [
        { name: "api-server", status: "running" },
        { name: "worker", status: "stopped" },
      ],
      headerColor: "cyan",
    },
  },

  List: {
    props: z.object({
      items: z.array(z.string()),
      ordered: z.boolean().nullable().optional(),
      bulletChar: z.string().nullable().optional(),
      spacing: z.number().nullable().optional(),
    }),
    slots: [],
    description: "Bulleted or numbered list. Each item is a string. Use for simple enumerations.",
    example: { items: ["Install dependencies", "Run tests", "Deploy"], ordered: true },
  },

  ListItem: {
    props: z.object({
      title: z.string(),
      subtitle: z.string().nullable().optional(),
      leading: z.string().nullable().optional(),
      trailing: z.string().nullable().optional(),
    }),
    slots: [],
    description:
      "Structured list row with title, optional subtitle, and leading/trailing text. Use with repeat for dynamic lists.",
    example: { title: "package.json", subtitle: "Modified 2 hours ago", leading: "*", trailing: "2.1 KB" },
  },

  Card: {
    props: z.object({
      title: z.string().nullable().optional(),
      backgroundColor: z.string().nullable().optional(),
      padding: z.number().nullable().optional(),
    }),
    slots: ["default"],
    description:
      "Grouping container with an optional title. Renders as a shaded background area with a bold title bar.",
    example: { title: "Details", padding: 1 },
  },

  KeyValue: {
    props: z.object({
      label: z.string(),
      value: z.union([z.string(), z.number(), z.array(z.string())]),
      labelColor: z.string().nullable().optional(),
      separator: z.string().nullable().optional(),
    }),
    slots: [],
    description:
      "Key-value pair display. Renders label and value on the same line. Value can be a string, number, or array of strings (joined with commas). Default separator is a colon.",
    example: { label: "Status", value: "Running", labelColor: "cyan" },
  },

  Link: {
    props: z.object({
      url: z.string(),
      label: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
    }),
    slots: [],
    description:
      'Renders a URL as underlined text with an OSC 8 hyperlink. If label is provided, shows "label (url)".',
    example: { url: "https://github.com/vercel-labs/json-render", label: "json-render" },
  },

  StatusLine: {
    props: z.object({
      text: z.string(),
      status: z.enum(["info", "success", "warning", "error"]).nullable().optional(),
      icon: z.string().nullable().optional(),
    }),
    slots: [],
    description:
      "Status message with colored icon. Default icons: info=ℹ, success=✔, warning=⚠, error=✖.",
    example: { text: "Build completed successfully", status: "success" },
  },

  Metric: {
    props: z.object({
      label: z.string(),
      value: z.string(),
      detail: z.string().nullable().optional(),
      trend: z.enum(["up", "down", "neutral"]).nullable().optional(),
    }),
    slots: [],
    description:
      "Key metric display with prominent value and optional trend indicator. Use for important numbers that deserve visual emphasis.",
    example: { label: "Revenue", value: "$70,686", detail: "24h change", trend: "up" },
  },

  Callout: {
    props: z.object({
      type: z.enum(["info", "tip", "warning", "important"]).nullable().optional(),
      title: z.string().nullable().optional(),
      content: z.string(),
    }),
    slots: [],
    description:
      "Highlighted callout block with colored left border. Use for key takeaways, tips, warnings, or important notes that should stand out from surrounding content.",
    example: {
      type: "tip",
      title: "Key Takeaway",
      content: "Revenue peaked in FY2022 driven by the phone upgrade cycle.",
    },
  },

  Timeline: {
    props: z.object({
      items: z.array(
        z.object({
          title: z.string(),
          description: z.string().nullable().optional(),
          date: z.string().nullable().optional(),
          status: z.enum(["completed", "current", "upcoming"]).nullable().optional(),
        }),
      ),
    }),
    slots: [],
    description:
      "Vertical timeline showing ordered events, steps, or milestones. Each item has a status-colored dot, title, optional date, and optional description.",
    example: {
      items: [
        { title: "Project Started", description: "Initial commit and setup", date: "Jan 2024", status: "completed" },
        { title: "Beta Release", description: "Public beta launched", date: "Mar 2024", status: "current" },
        { title: "v1.0", date: "Q2 2024", status: "upcoming" },
      ],
    },
  },

  Markdown: {
    props: z.object({
      text: z.string(),
    }),
    slots: [],
    description:
      "Renders markdown-formatted text with terminal styling. Supports headings (#), **bold**, *italic*, `inline code`, ~~strikethrough~~, fenced code blocks, lists (ordered and unordered), blockquotes (>), and horizontal rules (---).",
    example: {
      text: "## Overview\n\nThis is **bold** and *italic* text with `inline code`.\n\n- First item\n- Second item\n\n> A blockquote",
    },
  },

  // ==========================================================================
  // Interactive
  // ==========================================================================

  TextInput: {
    props: z.object({
      placeholder: z.string().nullable().optional(),
      value: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
      mask: z.string().nullable().optional(),
    }),
    events: ["submit", "change"],
    slots: [],
    description:
      "Text input field. Use $bindState on value for two-way binding. Press Enter to submit. Set mask to '*' for password fields.",
    example: { placeholder: "Type here...", label: "Name", value: { $bindState: "/form/name" } },
  },

  Select: {
    props: z.object({
      options: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
        }),
      ),
      value: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
    }),
    events: ["change"],
    slots: [],
    description:
      "Selection menu navigated with arrow keys. Use $bindState on value to bind the selected value to state. Press Enter to confirm selection.",
    example: {
      options: [
        { label: "Development", value: "dev" },
        { label: "Staging", value: "staging" },
        { label: "Production", value: "prod" },
      ],
      label: "Environment",
      value: { $bindState: "/env" },
    },
  },

  MultiSelect: {
    props: z.object({
      options: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
        }),
      ),
      value: z.array(z.string()).nullable().optional(),
      label: z.string().nullable().optional(),
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
    }),
    events: ["change", "submit"],
    slots: [],
    description:
      "Multi-selection menu. Navigate with arrow keys, toggle with space, confirm with enter. Use $bindState on value to bind the selected values array to state. Set min/max to constrain selection count.",
    example: {
      options: [
        { label: "TypeScript", value: "ts" },
        { label: "Python", value: "py" },
        { label: "Rust", value: "rs" },
      ],
      label: "Languages",
      value: { $bindState: "/languages" },
    },
  },

  ConfirmInput: {
    props: z.object({
      message: z.string().nullable().optional(),
      defaultValue: z.boolean().nullable().optional(),
      yesLabel: z.string().nullable().optional(),
      noLabel: z.string().nullable().optional(),
    }),
    events: ["confirm", "deny"],
    slots: [],
    description:
      "Yes/No confirmation prompt. Press Y to confirm, N to deny. Use for destructive or irreversible actions.",
    example: { message: "Delete all files?" },
  },

  Tabs: {
    props: z.object({
      tabs: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
          icon: z.string().nullable().optional(),
        }),
      ),
      value: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
    }),
    events: ["change"],
    slots: ["default"],
    description:
      "Tab bar navigation. Navigate with left/right arrow keys. Use $bindState on value to bind the active tab to state. Put tab panels in the children and use visible conditions to show the panel for the active tab.",
    example: {
      tabs: [
        { label: "Overview", value: "overview" },
        { label: "Logs", value: "logs" },
        { label: "Settings", value: "settings" },
      ],
      value: { $bindState: "/tab" },
    },
  },
};

/**
 * Standard action definitions.
 *
 * `setState`, `pushState`, and `removeState` are also declared as schema
 * built-in actions, so they are documented in generated prompts even when a
 * custom catalog omits them. They are listed here so `on` bindings using them
 * validate against the catalog.
 *
 * Ink's `exit` and `log` actions are intentionally not ported: a Pi panel is
 * not a standalone application, and stdout writes would corrupt Pi's renderer.
 */
export const standardActionDefinitions = {
  setState: {
    params: z.object({
      statePath: z.string(),
      value: z.unknown(),
    }),
    description: "Update a value in the state model at the given statePath.",
  },

  pushState: {
    params: z.object({
      statePath: z.string(),
      value: z.unknown(),
      clearStatePath: z.string().optional(),
    }),
    description:
      'Append an item to an array in the state model. The value can contain { $state: "/statePath" } references and "$id" for auto IDs. Use clearStatePath to reset another path after pushing.',
  },

  removeState: {
    params: z.object({
      statePath: z.string(),
      index: z.number(),
    }),
    description: "Remove an item from an array in the state model at the given index.",
  },
};

/** Type of one component definition entry. */
export type ComponentDefinition = {
  props: z.ZodType;
  slots: string[];
  events?: string[];
  description: string;
  example?: unknown;
};

/** Type of one action definition entry. */
export type ActionDefinition = {
  params: z.ZodType;
  description: string;
};
