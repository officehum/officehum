/**
 * The model-facing shape of a tool the manifest declares in full: its description with its
 * guidelines, and its parameters as a JSON Schema object. Engine tools and MCP tools both have no code
 * of their own for these, so both read them from `officehum.json` through here.
 */

import { bool, int, lit, num, obj, opt, type Schema, str, union } from "@earendil-works/pi-schema";
import type { ParameterDeclaration, ToolDeclaration } from "./manifest.js";

/** The tool's description, followed by its guidelines as a bullet list. */
export function declaredDescription(tool: ToolDeclaration): string {
  const guidelines = (tool.guidelines ?? []).map((line) => `- ${line}`).join("\n");
  const description = tool.description ?? tool.name;
  return guidelines === "" ? description : `${description}\n\n${guidelines}`;
}

/** The tool's declared parameters as the object schema the model fills in. */
export function declaredParameters(tool: ToolDeclaration): Schema<Record<string, unknown>> {
  const properties = Object.fromEntries(
    Object.entries(tool.parameters ?? {}).map(([name, parameter]) => {
      const schema = parameterSchema(parameter);
      return [name, parameter.required ? schema : opt(schema)];
    }),
  );
  return obj(properties, { open: true });
}

function parameterSchema(parameter: ParameterDeclaration) {
  const options = { description: parameter.description };
  if (parameter.enum !== undefined) {
    return union(
      parameter.enum.map((value) => lit(value)),
      options,
    );
  }
  switch (parameter.type) {
    case "string":
      return str(options);
    case "number":
      return num(options);
    case "integer":
      return int(options);
    case "boolean":
      return bool(options);
  }
}
