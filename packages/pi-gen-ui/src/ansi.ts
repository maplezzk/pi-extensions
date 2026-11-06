/**
 * Minimal ANSI styling helpers.
 *
 * json-render specs name terminal colors ("red", "cyan", "gray") or give hex
 * values, and the Ink renderer passes those straight through to ANSI. We do the
 * same so a spec keeps its intended colors instead of being remapped onto Pi's
 * semantic theme tokens, which have no magenta/cyan/blue equivalents. Theme
 * tokens are used only for chrome the spec does not color itself.
 *
 * Runs close with *selective* SGR resets rather than `\x1b[0m`. A full reset also
 * clears the background, and Pi paints its own background behind a tool result,
 * so one `\x1b[0m` mid-line made everything after it fall back to the terminal's
 * default background. Only the attributes a run actually turned on are undone
 * here, leaving the ambient background intact.
 */

/** Undo only the foreground color, keeping background and attributes. */
const RESET_FG = "\x1b[39m";
/** Undo only the background color, keeping foreground and attributes. */
const RESET_BG = "\x1b[49m";

/** Named foreground SGR codes, matching Ink's `color` vocabulary. */
const NAMED_FG: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackbright: 90,
  redbright: 91,
  greenbright: 92,
  yellowbright: 93,
  bluebright: 94,
  magentabright: 95,
  cyanbright: 96,
  whitebright: 97,
};

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_PATTERN = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/** Whether a color string is a supported literal (named, #rgb/#rrggbb, rgb()). */
export function isSupportedColor(color: string): boolean {
  return resolveSgr(color, false) !== undefined;
}

/** Parse `#rgb` / `#rrggbb` / `rgb(r,g,b)` into channel values, or undefined. */
function parseRgb(color: string): [number, number, number] | undefined {
  const hex = color.match(HEX_PATTERN);
  if (hex) {
    const digits = hex[1];
    const full = digits.length === 3 ? digits.replace(/(.)/g, "$1$1") : digits;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = color.match(RGB_PATTERN);
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] as [number, number, number];
    if (channels.every((value) => value >= 0 && value <= 255)) return channels;
  }
  return undefined;
}

/** Resolve a color name to its SGR parameters, or undefined when unsupported. */
function resolveSgr(color: string, background: boolean): string | undefined {
  const named = NAMED_FG[color.toLowerCase().replace(/[\s_-]/g, "")];
  if (named !== undefined) return String(background ? named + 10 : named);
  const rgb = parseRgb(color.trim());
  if (rgb) {
    const [r, g, b] = rgb;
    return `${background ? 48 : 38};2;${r};${g};${b}`;
  }
  return undefined;
}

/** Wrap text in a foreground color. Unsupported colors return the text unchanged. */
export function fg(color: string | null | undefined, text: string): string {
  if (!color) return text;
  const sgr = resolveSgr(color, false);
  return sgr ? `\x1b[${sgr}m${text}${RESET_FG}` : text;
}

/** Wrap text in a background color. Unsupported colors return the text unchanged. */
export function bg(color: string | null | undefined, text: string): string {
  if (!color) return text;
  const sgr = resolveSgr(color, true);
  return sgr ? `\x1b[${sgr}m${text}${RESET_BG}` : text;
}

/** SGR codes for the boolean text attributes json-render exposes. */
export const SGR = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
  strikethrough: 9,
} as const;

/** The SGR code that turns each attribute back off, without touching colors. */
const ATTRIBUTE_OFF: Readonly<Record<number, number>> = {
  [SGR.bold]: 22,
  [SGR.dim]: 22,
  [SGR.italic]: 23,
  [SGR.underline]: 24,
  [SGR.inverse]: 27,
  [SGR.strikethrough]: 29,
};

/** Attribute codes `style` understands. Anything else has no safe "off" code. */
type AttributeCode = (typeof SGR)[keyof typeof SGR];

/**
 * Apply an SGR attribute to text.
 *
 * The run closes with the matching attribute-off code so bold, italic, and the
 * like do not leak past their text. Color and background are deliberately left
 * alone: a `\x1b[0m` here would clear Pi's tool-result background. The parameter
 * is narrowed to the known attributes because an unknown code has no selective
 * counterpart, and falling back to a full reset would reintroduce that bug.
 */
export function style(code: AttributeCode, text: string): string {
  return `\x1b[${code}m${text}\x1b[${ATTRIBUTE_OFF[code]}m`;
}

/** OSC 8 hyperlink; terminals without support ignore the escapes and show the label. */
export function hyperlink(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/** Strip ANSI SGR/OSC sequences; used by tests and width math on plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
