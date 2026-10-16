/**
 * The tool-result shape guard.
 *
 * Pi Durable 1.2.0 renamed `ToolExecutionResult.content` to `output`. A tool that still returns
 * `content` keeps compiling: TypeScript's weak-type check for the result does not fire when the
 * result also sets a known field such as `details` or `isError`. At runtime Pi Durable ignores the
 * unknown field, so the model silently receives an empty result.
 *
 * `defineRole` wraps every tool it returns with `guardToolResult`, so the SDK owns the check rather
 * than the host or a role's own tests, and a third-party role gets it without knowing it exists.
 */

import type { ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Throws when a tool's result carries `content`. A Pi Durable 1.3.x result never has that field, so
 * any result that does is a leftover from the 1.2.0 rename, whatever else it sets. The message names
 * the tool and says how to fix it.
 */
export function guardToolResultShape(tool: string, result: unknown): void {
  if (result === null || typeof result !== "object") return;
  if (!Object.hasOwn(result, "content")) return;
  throw new Error(
    `The ${tool} tool returned a result with "content". Pi Durable 1.2.0 renamed that field to ` +
      `"output", and the model sees an empty result when a tool returns content. Return "output" ` +
      `instead, e.g. { output: [{ type: "text", text: "…" }] }.`,
  );
}

/**
 * Returns a copy of `tool` whose `execute` runs the shape guard on its result. Only `content` trips
 * it: a result that omits `output` and uses `api.output()`, or one that sets `isError` or `details`,
 * passes untouched.
 */
export function guardToolResult(tool: ToolRegistration): ToolRegistration {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args, api, context) => {
      const result = await execute(args, api, context);
      guardToolResultShape(tool.name, result);
      return result;
    },
  };
}
