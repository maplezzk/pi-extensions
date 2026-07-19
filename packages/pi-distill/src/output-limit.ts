import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function writeSummaryFile(summary: string): Promise<string> {
  const directory = join(tmpdir(), "pi-distill");
  await mkdir(directory, { recursive: true });
  const filePath = join(
    directory,
    `summary-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  await writeFile(filePath, summary, "utf8");
  return filePath;
}

export async function limitReturnedToolResult(
  result: OutputLimitToolResult,
  maxChars: number,
): Promise<OutputLimitToolResult> {
  const text = getTextContent(result);
  if (text.length <= maxChars) return result;

  try {
    const filePath = await writeSummaryFile(text);
    const pointer = `Output exceeded ${maxChars} chars and was written to: ${filePath}`;
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
    console.warn(`[pi-distill] Failed to write oversized output to a temp file; returning a truncated result: ${message}`);
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
