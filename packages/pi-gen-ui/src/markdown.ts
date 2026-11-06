import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SGR, fg, hyperlink, style } from "./ansi.ts";
import { clampLine, padLine, rule } from "./layout.ts";

/**
 * Small markdown renderer for the Markdown component.
 *
 * Deliberately limited to the constructs json-render catalogs advertise:
 * headings, bold, italic, inline code, strikethrough, fenced code, lists,
 * blockquotes, links, and horizontal rules. Tables and nested lists are
 * rendered as plain text lines rather than being silently dropped.
 */

const INLINE_PATTERN =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\n]+\))/g;

/** Apply inline markdown styling to one line of text. */
export function renderInline(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const start = match.index ?? 0;
    result += text.slice(cursor, start);
    cursor = start + token.length;

    if (token.startsWith("**") || token.startsWith("__")) {
      result += style(SGR.bold, token.slice(2, -2));
    } else if (token.startsWith("~~")) {
      result += style(SGR.strikethrough, token.slice(2, -2));
    } else if (token.startsWith("`")) {
      result += fg("cyan", token.slice(1, -1));
    } else if (token.startsWith("*") || token.startsWith("_")) {
      result += style(SGR.italic, token.slice(1, -1));
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) result += style(SGR.underline, hyperlink(link[2], link[1]));
      else result += token;
    }
  }
  result += text.slice(cursor);
  return result;
}

/** Wrap already-styled text to `width`, keeping styling per line. */
function wrapStyled(styled: string, width: number): string[] {
  if (visibleWidth(styled) <= width) return [styled];
  return wrapTextWithAnsi(styled, width);
}

/** Options for prefixing a wrapped list item. */
interface PrefixWrapOptions {
  /** Plain prefix used to size the continuation indent. */
  prefix: string;
  /** Styled prefix written before the first line. */
  styledPrefix: string;
  /** Inline-styled body text. */
  body: string;
  /** Total width available. */
  width: number;
}

/** Wrap a list item body after `prefix`, indenting continuation lines. */
function wrapWithPrefix(options: PrefixWrapOptions): string[] {
  const { prefix, styledPrefix, body, width } = options;
  const indent = " ".repeat(visibleWidth(prefix));
  const wrapped = wrapStyled(body, Math.max(1, width - visibleWidth(prefix)));
  return wrapped.map((line, index) => clampLine(index === 0 ? styledPrefix + line : indent + line, width));
}

/** Render markdown into terminal lines. */
export function renderMarkdown(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const source = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < source.length) {
    const line = source[index];

    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      index += 1;
      const code: string[] = [];
      while (index < source.length && !source[index].trimStart().startsWith("```")) {
        code.push(source[index]);
        index += 1;
      }
      index += 1;
      if (language) out.push(fg("gray", `  ${language}`));
      for (const codeLine of code) {
        for (const wrapped of wrapStyled(fg("gray", `  ${codeLine}`), safeWidth)) out.push(wrapped);
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2]);
      const decorated =
        level <= 2
          ? style(SGR.bold, style(SGR.underline, content))
          : level === 3
            ? style(SGR.bold, content)
            : style(SGR.dim, content);
      for (const wrapped of wrapStyled(decorated, safeWidth)) out.push(wrapped);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push(fg("gray", rule("─", safeWidth)));
      index += 1;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const body = wrapStyled(renderInline(quote[1]), Math.max(1, safeWidth - 2));
      for (const wrapped of body) {
        out.push(style(SGR.dim, fg("gray", "│ ")) + padLine(clampLine(wrapped, safeWidth - 2), safeWidth - 2));
      }
      index += 1;
      continue;
    }

    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1];
      const ordered = /\d/.test(bullet[2].charAt(0));
      const marker = ordered ? `${bullet[2]} ` : "• ";
      out.push(
        ...wrapWithPrefix({
          prefix: indent + marker,
          styledPrefix: indent + fg("cyan", marker),
          body: renderInline(bullet[3]),
          width: safeWidth,
        }),
      );
      index += 1;
      continue;
    }

    if (line.trim() === "") {
      out.push("");
      index += 1;
      continue;
    }

    for (const wrapped of wrapStyled(renderInline(line), safeWidth)) out.push(wrapped);
    index += 1;
  }

  return out.length > 0 ? out : [""];
}
