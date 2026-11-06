import { defineSchema, type Spec } from "@json-render/core";

/**
 * Pi terminal schema definition.
 *
 * The element-tree grammar deliberately matches `@json-render/ink`'s schema so
 * a spec generated for one terminal renderer stays valid for the other. It is a
 * strict superset: `slots`, `on`, `watch`, and the top-level `state` field are
 * declared as optional here so `catalog.validate()` and `catalog.jsonSchema()`
 * describe the full spec, while an Ink spec that omits them still validates.
 */
export const schema = defineSchema(
  (s) => ({
    spec: s.object({
      /** Root element key. */
      root: s.string(),
      /** Flat map of elements by key. */
      elements: s.record(
        s.object({
          /** Component type from catalog. */
          type: s.ref("catalog.components"),
          /** Component props. */
          props: s.propsOf("catalog.components"),
          /** Child element keys (flat reference). */
          children: s.array(s.string()),
          /** Named slot element keys; `default` holds inline children. */
          slots: { ...s.any(), ...s.optional() },
          /** Visibility condition. */
          visible: { ...s.any(), ...s.optional() },
          /** Repeat children from a state array. */
          repeat: { ...s.any(), ...s.optional() },
          /** Event bindings (press, change, submit, confirm, deny). */
          on: { ...s.any(), ...s.optional() },
          /** Reactive bindings that fire when a state path changes. */
          watch: { ...s.any(), ...s.optional() },
        }),
      ),
      /** Initial state model; top-level sibling of `root` and `elements`. */
      state: { ...s.any(), ...s.optional() },
    }),
    catalog: s.object({
      components: s.map({
        /** Zod schema for component props. */
        props: s.zod(),
        /** Slots for this component. Use ['default'] for children, or named slots like ['header', 'footer']. */
        slots: s.array(s.string()),
        /** Event names this component can bind through `on`. */
        events: { ...s.array(s.string()), ...s.optional() },
        /** Description for AI generation hints. */
        description: s.string(),
        /** Example prop values used in prompt examples (auto-generated from the Zod schema if omitted). */
        example: { ...s.any(), ...s.optional() },
      }),
      actions: s.map({
        /** Zod schema for action params. */
        params: s.zod(),
        /** Description for AI generation hints. */
        description: s.string(),
      }),
    }),
  }),
  {
    builtInActions: [
      {
        name: "setState",
        description:
          "Update a value in the state model at the given statePath. Params: { statePath: string, value: any }",
      },
      {
        name: "pushState",
        description:
          'Append an item to an array in state. Params: { statePath: string, value: any, clearStatePath?: string }. Value can contain {"$state":"/path"} refs and "$id" for auto IDs.',
      },
      {
        name: "removeState",
        description:
          "Remove an item from an array in state by index. Params: { statePath: string, index: number }",
      },
    ],
    defaultRules: [
      // Element integrity
      "CRITICAL INTEGRITY CHECK: Before outputting ANY element that references children, you MUST have already output (or will output) each child as its own element. If an element has children: ['a', 'b'], then elements 'a' and 'b' MUST exist. A missing child element causes that entire branch of the UI to be invisible.",
      "SELF-CHECK: After generating all elements, mentally walk the tree from root. Every key in every children array must resolve to a defined element. If you find a gap, output the missing element immediately.",
      'REQUIRED FIELDS: Every element MUST include a "children" array. Leaf elements (text, badges, inputs, images) use an empty array: "children": []. Omitting "children" fails validation.',
      // Field placement
      'CRITICAL: The "visible" field goes on the ELEMENT object, NOT inside "props". Correct: {"type":"<ComponentName>","props":{},"visible":{"$state":"/tab","eq":"home"},"children":[...]}.',
      'CRITICAL: The "on" field goes on the ELEMENT object, NOT inside "props". Use on.press, on.change, on.submit etc. NEVER put action/actionParams inside props.',
      // State and data
      "When the user asks for a UI that displays data (e.g. logs, tasks, metrics), ALWAYS include a state field with realistic sample data. The state field is a top-level field on the spec (sibling of root/elements).",
      'When building repeating content backed by a state array, use the "repeat" field on a container element. Example: { "type": "Box", "props": { "flexDirection": "column" }, "repeat": { "statePath": "/items", "key": "id" }, "children": ["item-row"] }. For a nested list stored on the enclosing item, use "repeat": { "statePath": { "$item": "children" }, "key": "id" }. The $item statePath form is valid only inside another repeat. Inside repeated children, use { "$item": "field" } to read from the current item and { "$index": true } for the current index.',
      // Pi terminal design guidance
      "This UI renders inside the Pi coding agent's terminal transcript. Use Box for layout (flexDirection, gap, padding), Text for text content. Keep designs compact and readable in monospace.",
      "Terminal width is limited. Prefer vertical layouts (flexDirection: column) for main structure. Use flexDirection: row for inline elements such as badges, key-value pairs, divider titles, and table rows.",
      "Box supports flexDirection, gap, align, padding and borderStyle, but NOT flexWrap or absolute positioning. Do not rely on wrapping a row; split long content into multiple rows instead.",
      "Use borderStyle on Box for visual grouping (single, double, round, bold, classic). Use padding sparingly — 1 unit is usually enough.",
      "For color, use named terminal colors: red, green, yellow, blue, magenta, cyan, white, gray. Hex colors are not supported and are ignored.",
      "Always include realistic, professional-looking sample data. For lists include 3-5 items with varied content. Never leave data empty.",
      "Use Heading for section titles, Divider to separate sections, Badge for status indicators, KeyValue for labeled data, and Card for grouped content.",
      "Use Tabs for multi-view UIs — bind the active tab to state and use visible conditions on child content to show/hide tab panels. Use MultiSelect for picking multiple items. Use ConfirmInput for yes/no prompts before destructive actions.",
      "Use Sparkline for compact inline trends, ProgressBar for a single completion ratio, and BarChart for comparing values across categories.",
      "Prefer Select, MultiSelect, TextInput, Tabs and ConfirmInput when the user must provide input. Interactive components only receive keyboard input while the tool is waiting for the user, so keep them at the top level and do not bury them inside collapsed or repeated branches.",
      "Never embed raw ANSI escape sequences in props. Styling comes from color, bold, italic, underline, dimColor and borderStyle props.",
    ],
  },
);

/** Type alias for the Pi terminal schema. */
export type PiJsonRenderSchema = typeof schema;

/** Spec type for the Pi terminal renderer. */
export type PiJsonRenderSpec = Spec;
