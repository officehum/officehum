/**
 * A template's data against its JSON Schema, with TypeBox's validator (already the SDK's): every
 * problem, each with its field path, so a caller fixes all of them at once. And sample data built
 * from a schema, which an overlay template must compile with before the office accepts it.
 */

import { Value } from "typebox/value";
import type { DataProblem } from "./errors.js";

type Json = Readonly<Record<string, unknown>>;

/** Every way `data` fails `schema`, sorted by path; empty when it matches. */
export function dataProblems(schema: Json, data: unknown): DataProblem[] {
  const problems = new Map<string, DataProblem>();
  const add = (path: string, message: string) =>
    problems.set(`${path}\u0000${message}`, { path, message });
  for (const error of Value.Errors(schema, data)) {
    const at = fieldPath(error.instancePath);
    const params = error.params as Record<string, unknown>;
    switch (error.keyword) {
      case "required":
        for (const name of (params.requiredProperties as string[] | undefined) ?? []) {
          add(at, `is missing ${name}`);
        }
        break;
      // TypeBox reports an extra field twice: as the field itself, and as the object holding it.
      case "additionalProperties":
        break;
      case "boolean":
        add(
          at,
          at === "data" ? "is not accepted by this template" : "is not a field this template takes",
        );
        break;
      case "enum":
        add(
          at,
          `must be one of ${((params.allowedValues as unknown[]) ?? []).map(String).join(", ")}`,
        );
        break;
      default:
        add(at, error.message);
    }
  }
  return [...problems.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.message.localeCompare(right.message),
  );
}

/** A JSON pointer as a field path a person reads: `/lines/0/amount` is `data.lines[0].amount`. */
function fieldPath(pointer: string): string {
  if (pointer === "") return "data";
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"))
    .reduce(
      (path, segment) =>
        /^\d+$/u.test(segment)
          ? `${path}[${segment}]`
          : /^[A-Za-z_$][\w$]*$/u.test(segment)
            ? `${path}.${segment}`
            : `${path}[${JSON.stringify(segment)}]`,
      "data",
    );
}

/**
 * Data for a schema: its first `examples` entry when it has one, otherwise the smallest data that
 * matches it (required fields only, a default, constant or first allowed value where one is named).
 */
export function sampleData(schema: Json): unknown {
  const examples = schema.examples;
  if (Array.isArray(examples) && examples.length > 0) return examples[0];
  return sample(schema, 0);
}

function sample(schema: Json, depth: number): unknown {
  if (depth > 16) return null;
  if ("default" in schema) return schema.default;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches) && isObject(branches[0])) return sample(branches[0], depth + 1);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const properties = isObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
      const out: Record<string, unknown> = {};
      for (const name of required) {
        const property = properties[name];
        out[name] = isObject(property) ? sample(property, depth + 1) : "Sample";
      }
      return out;
    }
    case "array": {
      const count = Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 0);
      const items = isObject(schema.items) ? schema.items : {};
      return Array.from({ length: count }, () => sample(items, depth + 1));
    }
    case "integer":
    case "number": {
      const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
      const value = minimum === undefined ? 1 : Math.max(minimum, 1);
      return type === "integer" ? Math.ceil(value) : value;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    case "string": {
      if (schema.format === "date") return "2026-01-31";
      if (schema.format === "date-time") return "2026-01-31T09:00:00Z";
      const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
      return "Sample".repeat(Math.max(1, Math.ceil(minLength / 6)));
    }
    default:
      return "Sample";
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
