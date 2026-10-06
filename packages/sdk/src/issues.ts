/**
 * Validation problems, reported all at once with a path and a plain message, e.g.
 * `officehum.json › tools[1].replay: must be one of "safe", "unsafe" (got "maybe")`.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** One problem found while validating a role package. */
export interface Issue {
  /** Where the problem is: a file name such as `officehum.json`, or `role` for the factory's output. */
  readonly source: string;
  /** Path inside the source, e.g. `tools[1].replay`; empty for the source as a whole. */
  readonly path: string;
  readonly message: string;
}

/** The outcome of a validation: the typed value, or every problem found. */
export type Validation<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/** Renders an issue as one line. */
export function formatIssue(issue: Issue): string {
  return issue.path === ""
    ? `${issue.source}: ${issue.message}`
    : `${issue.source} › ${issue.path}: ${issue.message}`;
}

/** Turns a JSON pointer (`/tools/1/replay`) into a readable path (`tools[1].replay`). */
export function formatPointer(pointer: string): string {
  let path = "";
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    path += /^\d+$/.test(segment) ? `[${segment}]` : path === "" ? segment : `.${segment}`;
  }
  return path;
}

/** Joins a readable path and a child key. */
export function joinPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  if (key === "") return path;
  if (key.startsWith("[")) return `${path}${key}`;
  return path === "" ? key : `${path}.${key}`;
}

/** Shows a value inside a message, quoting strings. */
export function show(value: unknown): string {
  if (value === undefined) return "nothing";
  return JSON.stringify(value) ?? String(value);
}

/**
 * Checks `value` against a TypeBox schema and translates the errors into plain messages. A string
 * schema may carry an `x-hint` (e.g. `kebab-case, like "front-desk"`) used when its pattern fails.
 */
export function schemaIssues(schema: TSchema, value: unknown, source: string): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const push = (path: string, message: string) => {
    const key = `${path}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ source, path, message });
  };

  for (const error of Value.Errors(schema, value)) {
    const path = formatPointer(error.instancePath);
    const actual = valueAt(value, error.instancePath);
    switch (error.keyword) {
      case "boolean":
        // `additionalProperties: false` reports each extra field twice; the named report below wins.
        break;
      case "additionalProperties":
        for (const name of error.params.additionalProperties) {
          push(joinPath(path, name), "is not a known field");
        }
        break;
      case "required":
        for (const name of error.params.requiredProperties)
          push(joinPath(path, name), "is required");
        break;
      case "enum":
        push(
          path,
          `must be one of ${error.params.allowedValues.map(show).join(", ")} (got ${show(actual)})`,
        );
        break;
      case "const":
        push(path, `must be ${show(error.params.allowedValue)} (got ${show(actual)})`);
        break;
      case "type":
        push(path, `must be ${article(String(error.params.type))} (got ${show(actual)})`);
        break;
      case "pattern": {
        const hint = schemaAt(schema, error.schemaPath)?.["x-hint"];
        push(
          path,
          `must be ${typeof hint === "string" ? hint : `like ${error.params.pattern}`} (got ${show(actual)})`,
        );
        break;
      }
      default:
        push(path, error.message);
    }
  }
  return issues;
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function valueAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const segment of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return current;
}

function schemaAt(schema: TSchema, schemaPath: string): Record<string, unknown> | undefined {
  let current: unknown = schema;
  for (const segment of schemaPath.replace(/^#/, "").split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== null && typeof current === "object"
    ? (current as Record<string, unknown>)
    : undefined;
}
