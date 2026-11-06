import { z } from "zod";
import { standardActionDefinitions, standardComponentDefinitions } from "./catalog.ts";
import { SUPPORTED_BORDER_STYLES, SUPPORTED_PROPS } from "./capabilities.ts";
import { schema } from "./schema.ts";

/**
 * Generates the on-demand markdown reference for the model.
 *
 * The reference is derived from the same catalog the renderer uses, so it can
 * never drift from validation. It is written on demand and read through Pi's
 * normal `read` tool instead of sitting in the system prompt on every turn.
 */

type JsonSchema = Record<string, unknown>;

/** Render one JSON Schema node as a compact TypeScript-like signature. */
function signature(node: JsonSchema | undefined, depth = 0): string {
  if (!node || depth > 6) return "unknown";

  const enumValues = node.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }

  const constValue = node.const;
  if (constValue !== undefined) return JSON.stringify(constValue);

  const anyOf = node.anyOf ?? node.oneOf;
  if (Array.isArray(anyOf)) {
    const parts = (anyOf as JsonSchema[])
      .map((branch) => signature(branch, depth + 1))
      .filter((text, index, all) => all.indexOf(text) === index);
    return parts.join(" | ");
  }

  const rawType = node.type;
  const types = Array.isArray(rawType) ? (rawType as string[]) : typeof rawType === "string" ? [rawType] : [];
  if (types.length > 1) {
    return types
      .map((type) => signature({ ...node, type }, depth + 1))
      .filter((text, index, all) => all.indexOf(text) === index)
      .join(" | ");
  }

  switch (types[0]) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = signature(node.items as JsonSchema | undefined, depth + 1);
      return items.includes("|") ? `(${items})[]` : `${items}[]`;
    }
    case "object": {
      const properties = node.properties as Record<string, JsonSchema> | undefined;
      if (!properties) {
        const additional = node.additionalProperties;
        if (additional && typeof additional === "object" && Object.keys(additional).length > 0) {
          return `Record<string, ${signature(additional as JsonSchema, depth + 1)}>`;
        }
        return "object";
      }
      const required = new Set((node.required as string[] | undefined) ?? []);
      const body = Object.entries(properties)
        .map(([name, value]) => `${name}${required.has(name) ? "" : "?"}: ${signature(value, depth + 1)}`)
        .join("; ");
      return `{ ${body} }`;
    }
    default:
      return "unknown";
  }
}

/** Render a component's props as one signature line, marking ignored props. */
function propsLine(component: string, props: z.ZodType): string {
  const jsonSchema = z.toJSONSchema(props, { io: "input" }) as JsonSchema;
  const properties = (jsonSchema.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set((jsonSchema.required as string[] | undefined) ?? []);
  const supported = SUPPORTED_PROPS[component];

  const body = Object.entries(properties)
    .map(([name, value]) => {
      const optional = required.has(name) ? "" : "?";
      const ignored = supported && !supported.includes(name) ? "  // IGNORED on Pi" : "";
      return `${name}${optional}: ${signature(value)}${ignored}`;
    })
    .join(";\n    ");

  return `{\n    ${body}\n  }`;
}

/** Build the full markdown reference. */
export function renderCatalogDoc(): string {
  const lines: string[] = [];

  lines.push("# json-render component reference (pi-gen-ui terminal renderer)");
  lines.push("");
  lines.push(
    "This file is generated from the `pi-gen-ui` catalog. Edit the catalog, not this file.",
  );
  lines.push("");
  lines.push("## Spec shape");
  lines.push("");
  lines.push("```jsonc");
  lines.push("{");
  lines.push('  "root": "<element key>",        // required');
  lines.push('  "elements": { "<key>": {          // required, flat map');
  lines.push('      "type": "<ComponentName>",');
  lines.push('      "props": { },');
  lines.push('      "children": ["<key>", "..."] // required for every element, [] for leaves');
  lines.push('      // optional: "visible", "repeat", "on", "watch"');
  lines.push("  } },");
  lines.push('  "state": { }                      // optional initial state model');
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push(
    "`children` is a REQUIRED array on every element. Leaf elements use `[]`. Children reference other entries in `elements` by key.",
  );
  lines.push("");
  lines.push("Dynamic values usable inside `props`:");
  lines.push("");
  lines.push("| Expression | Meaning |");
  lines.push("| --- | --- |");
  lines.push('| `{ "$state": "/path" }` | read from the state model |');
  lines.push('| `{ "$item": "field" }` | read a field of the current repeat item |');
  lines.push('| `{ "$index": true }` | current repeat index |');
  lines.push('| `{ "$bindState": "/path" }` | two-way binding (interactive components) |');
  lines.push('| `{ "$bindItem": "field" }` | two-way binding to a repeat item field |');
  lines.push('| `{ "$cond": {...}, "$then": x, "$else": y }` | conditional value |');
  lines.push("");
  lines.push("## Components");
  lines.push("");

  for (const [name, definition] of Object.entries(standardComponentDefinitions)) {
    lines.push(`### ${name}`);
    lines.push("");
    lines.push(definition.description);
    lines.push("");
    lines.push("```ts");
    lines.push(`props: ${propsLine(name, definition.props)}`);
    lines.push("```");
    const slotNames = definition.slots as readonly string[];
    const events = (definition as { events?: readonly string[] }).events;
    if (slotNames.length > 0) {
      lines.push(`- slots: ${slotNames.map((slot) => `\`${slot}\``).join(", ")}`);
    }
    if (events && events.length > 0) {
      lines.push(`- events: ${events.map((event) => `\`on.${event}\``).join(", ")}`);
    }
    if (definition.example !== undefined) {
      lines.push(`- example: \`${JSON.stringify(definition.example)}\``);
    }
    lines.push("");
  }

  lines.push("## Actions");
  lines.push("");
  for (const [name, definition] of Object.entries(standardActionDefinitions)) {
    lines.push(`- \`${name}\` — ${definition.description}`);
    lines.push(`  params: \`${JSON.stringify(z.toJSONSchema(definition.params, { io: "input" }))}\``);
  }
  for (const builtIn of schema.builtInActions ?? []) {
    lines.push(`- \`${builtIn.name}\` — ${builtIn.description}`);
  }
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  for (const [index, rule] of (schema.defaultRules ?? []).entries()) {
    lines.push(`${index + 1}. ${rule}`);
  }
  lines.push("");
  lines.push("## Renderer limits");
  lines.push("");
  lines.push(
    `- Supported border styles: ${SUPPORTED_BORDER_STYLES.map((style) => `\`${style}\``).join(", ")}.`,
  );
  lines.push(
    "- Props marked `// IGNORED on Pi` in the component signatures above are accepted by validation but have no visual effect. The renderer reports every ignored prop it sees; avoid them.",
  );
  lines.push(
    "- Colors: named terminal colors (`red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`, plus `*Bright` variants) or `#rgb` / `#rrggbb` / `rgb(r,g,b)`. Unsupported color strings are ignored and reported.",
  );
  lines.push("");
  lines.push("## Complete example");
  lines.push("");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        root: "panel",
        elements: {
          panel: {
            type: "Box",
            props: { flexDirection: "column", padding: 1, gap: 1, borderStyle: "round" },
            children: ["title", "divider", "row", "list"],
          },
          title: { type: "Heading", props: { text: "Deployments", level: "h1" }, children: [] },
          divider: { type: "Divider", props: { title: "services" }, children: [] },
          row: {
            type: "Box",
            props: { flexDirection: "row", gap: 1 },
            children: ["badge", "keyvalue"],
          },
          badge: { type: "Badge", props: { label: "LIVE", variant: "success" }, children: [] },
          keyvalue: { type: "KeyValue", props: { label: "Region", value: "eu-west-1" }, children: [] },
          list: {
            type: "List",
            props: { items: ["api-server", "worker", "cron"], ordered: false },
            children: [],
          },
        },
        state: {},
      },
      null,
      2,
    ),
  );
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}
