/**
 * Minimal ANSI styling helpers.
 *
 * json-render specs name terminal colors ("red", "cyan", "gray") or give hex
 * values, and the Ink renderer passes those straight through to ANSI. We do the
 * same so a spec keeps its intended colors instead of being remapped onto Pi's
 * semantic theme tokens, which have no magenta/cyan/blue equivalents. Theme
 * tokens are used only for chrome the spec does not color itself.
 */

const RESET = "\x1b[0m";

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
  return sgr ? `\x1b[${sgr}m${text}${RESET}` : text;
}

/** Wrap text in a background color. Unsupported colors return the text unchanged. */
export function bg(color: string | null | undefined, text: string): string {
  if (!color) return text;
  const sgr = resolveSgr(color, true);
  return sgr ? `\x1b[${sgr}m${text}${RESET}` : text;
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

/** Apply an SGR code to text. */
export function style(code: number, text: string): string {
  return `\x1b[${code}m${text}${RESET}`;
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
