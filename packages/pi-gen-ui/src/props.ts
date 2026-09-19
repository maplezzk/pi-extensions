/** Small typed readers for spec props, with defaults for missing/`null` values. */

/** Read a string prop, falling back when the value is missing or the wrong type. */
export function str(props: Record<string, unknown>, name: string, fallback = ""): string {
  const value = props[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** Read a string prop, returning undefined when it is missing or empty. */
export function optionalStr(props: Record<string, unknown>, name: string): string | undefined {
  const value = props[name];
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  return undefined;
}

/** Read a numeric prop, falling back when the value is missing or not finite. */
export function num(props: Record<string, unknown>, name: string, fallback: number): number {
  const value = props[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Read a numeric prop, returning undefined when it is missing or not finite. */
export function optionalNum(props: Record<string, unknown>, name: string): number | undefined {
  const value = props[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read a boolean prop, falling back when the value is missing or the wrong type. */
export function bool(props: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = props[name];
  return typeof value === "boolean" ? value : fallback;
}

/** Read an array prop, returning an empty array for missing or non-array values. */
export function list<T = unknown>(props: Record<string, unknown>, name: string): T[] {
  const value = props[name];
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Read an enum-like prop, returning undefined when the value is not in `allowed`. */
export function oneOf<T extends string>(
  props: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = props[name];
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Read a record prop, returning undefined for missing or non-object values. */
export function record(props: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = props[name];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
