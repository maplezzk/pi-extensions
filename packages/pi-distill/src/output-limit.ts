import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

export type OutputLimitToolResult = {
  content: Array<{ type?: string; text?: string }>;
  details?: {
    [key: string]: unknown;
  };
};

export function getTextContent(result: OutputLimitToolResult): string {
  return result.content
    .filter((content) => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text ?? "")
    .join("\n");
}

export function hasNonTextContent(result: OutputLimitToolResult): boolean {
  return result.content.some((content) => content.type !== "text" || typeof content.text !== "string");
}

async function writeOutputFile(text: string): Promise<string> {
  const directory = join(tmpdir(), "pi-distill");
  await mkdir(directory, { recursive: true });
  const filePath = join(
    directory,
    `output-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  await writeFile(filePath, text, "utf8");
  return filePath;
}

/** Limit text entering the next Agent context; preserve non-text content. */
export async function limitReturnedToolResult(
  result: OutputLimitToolResult,
  maxChars: number,
): Promise<OutputLimitToolResult> {
  if (hasNonTextContent(result)) return result;

  const text = getTextContent(result);
  if (text.length <= maxChars) return result;

  try {
    const filePath = await writeOutputFile(text);
    const pointer = i18n.t("outputLimitExceeded", { maxChars, path: filePath });
    return {
      ...result,
      content: [{ type: "text", text: pointer.slice(0, maxChars) }],
      details: {
        ...(result.details ?? {}),
        fullOutputPath: filePath,
        outputTruncated: true,
        outputLimitChars: maxChars,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(i18n.t("outputLimitWriteFailed", { error: message }));
    return {
      ...result,
      content: [{ type: "text", text: text.slice(0, maxChars) }],
      details: {
        ...(result.details ?? {}),
        outputTruncated: true,
        outputLimitChars: maxChars,
        outputFileError: message,
      },
    };
  }
}
