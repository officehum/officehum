/**
 * The pack's two tools, as Pi Durable registrations: `document_generate` and `document_templates`.
 * Both are `replay: "safe"`. `document_templates` only reads; `document_generate` saves one draft
 * per call under an operation ID derived from the Pi Durable call, so an interrupted call that
 * reruns returns the same file instead of a second one.
 *
 * Neither takes a path, a URL or a file to read: the template is a name from the catalog, the data
 * is JSON checked against the template's schema, and branding is the host's, not the model's.
 */

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { map, obj, oneOf, type Schema, str, unknown } from "@earendil-works/pi-schema";
import { fileResult } from "@officehum/sdk";
import {
  type DocumentLease,
  type LeaseLookup,
  operationIdForCall,
} from "@officehum/tools-paper-office";
import { DocgenError } from "./errors.js";
import {
  type DocumentGenerator,
  type DocumentGeneratorOptions,
  documentGenerator,
} from "./generator.js";
import { TEMPLATE_FORMATS, type TemplateFormat } from "./templates.js";

export const DOCUMENT_GENERATE = "document_generate";
export const DOCUMENT_TEMPLATES = "document_templates";
export const DOCGEN_PACK_ID = "docgen";

export interface DocumentGenerationPackOptions extends DocumentGeneratorOptions {
  /** The task's document lease, which Word and Excel need; `undefined` when it has none. */
  readonly leaseFor?: (lookup: LeaseLookup) => Promise<DocumentLease | undefined>;
}

export interface DocumentGenerationPack {
  readonly id: string;
  readonly tools: readonly ToolRegistration[];
  /** The same generator the tools use, for a role's own tool that supplies exact figures. */
  readonly generator: DocumentGenerator;
}

const GENERATE_PARAMETERS = obj(
  {
    template: str({ minLength: 1, description: "A template name from document_templates." }),
    data: map(unknown(), {
      description:
        "The template's data, matching its schema exactly. Every figure as it was given to you.",
    }),
    format: oneOf(TEMPLATE_FORMATS, { description: "pdf, docx or xlsx, as the template allows." }),
    name: str({
      minLength: 1,
      description: "The file name, e.g. statement-lee-hardware-november. The extension is added.",
    }),
  },
  { description: "Which template, its data, the format and the file name." },
);

const TEMPLATES_PARAMETERS = obj({}, { description: "No arguments." });

const DESCRIPTIONS = {
  generate: [
    "Make a document from a template, in the business's branding: a letter, memo, report, quote,",
    "customer statement or meeting notes (see document_templates for the list, each template's data",
    "schema and the formats it renders). The data is checked against the schema first; every field that",
    "does not fit is reported with its path. Saves a new draft file and returns it, with a picture of a",
    "PDF's first page.",
    "For a document with financial figures (a quote, a statement, an invoice), use the role's own tool",
    "that fetches the figures and makes the document; use document_generate for prose documents and for",
    "figures a tool already gave you in this conversation, copied exactly. Never type or work out a",
    "number yourself.",
  ].join("\n"),
  templates:
    "List the document templates you can use with document_generate: each one's name, what it is for, " +
    "the formats it renders, its version and the JSON Schema its data must match.",
} as const;

type ToolDetails = {
  files?: string[];
  template?: string;
  version?: string;
  format?: string;
  code?: string;
  templates?: string[];
};

type ToolResult = {
  readonly output: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  readonly isError?: boolean;
  readonly details: ToolDetails;
};

export function documentGenerationPack(
  options: DocumentGenerationPackOptions,
): DocumentGenerationPack {
  const generator = documentGenerator(options);
  return {
    id: DOCGEN_PACK_ID,
    generator,
    tools: [
      tool(DOCUMENT_GENERATE, DESCRIPTIONS.generate, GENERATE_PARAMETERS, async (args, call) => {
        const format = args.format;
        if (
          typeof format !== "string" ||
          !(TEMPLATE_FORMATS as readonly string[]).includes(format)
        ) {
          throw new DocgenError("invalid-request", "format must be pdf, docx or xlsx");
        }
        if (typeof args.template !== "string" || typeof args.name !== "string") {
          throw new DocgenError("invalid-request", "template and name must be text");
        }
        const lease = format === "pdf" ? undefined : await options.leaseFor?.(call.lookup);
        const rendered = await generator.renderDocument({
          template: args.template,
          data: args.data,
          format: format as TemplateFormat,
          name: args.name,
          operationId: call.operationId,
          taskId: call.lookup.taskId,
          ...(lease === undefined ? {} : { lease }),
        });
        const result = fileResult([rendered.ref], {
          tool: DOCUMENT_GENERATE,
          ...(rendered.preview === undefined ? {} : { preview: rendered.preview }),
        });
        const summary = {
          ok: true,
          template: rendered.template.name,
          version: rendered.template.version,
          format: rendered.format,
          versionId: rendered.ref.versionId,
          published: false,
          ...(rendered.previewNote === undefined ? {} : { preview: rendered.previewNote }),
        };
        return {
          output: [...result.output, { type: "text", text: JSON.stringify(summary) }],
          details: {
            files: result.details.files,
            template: rendered.template.name,
            version: rendered.template.version,
            format: rendered.format,
          },
        } as ToolResult;
      }),
      tool(DOCUMENT_TEMPLATES, DESCRIPTIONS.templates, TEMPLATES_PARAMETERS, async () => {
        const templates = generator.templates().map((template) => ({
          name: template.name,
          title: template.title,
          description: template.description,
          formats: template.formats,
          origin: template.origin,
          version: template.version,
          schema: withoutExamples(template.schema),
        }));
        return {
          output: [{ type: "text", text: JSON.stringify({ templates }, null, 2) }],
          details: { templates: templates.map((template) => template.name) },
        };
      }),
    ],
  };
}

/** A schema without its `examples`: they show the model sample figures it must never reuse. */
function withoutExamples(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { examples: _examples, ...rest } = schema;
  return rest;
}

interface CallContext {
  readonly lookup: LeaseLookup;
  readonly operationId: string;
}

function tool(
  name: string,
  description: string,
  parameters: Schema,
  run: (args: Record<string, unknown>, call: CallContext) => Promise<ToolResult>,
): ToolRegistration {
  return defineTool({
    name,
    description,
    parameters,
    replay: "safe",
    execute: async (args: unknown, api): Promise<ToolResult> => {
      const lookup = { taskId: String(api.taskId), conversationId: String(api.conversationId) };
      const operationId = operationIdForCall({
        conversationId: lookup.conversationId,
        callId: api.callId,
      });
      try {
        if (typeof args !== "object" || args === null) {
          throw new DocgenError("invalid-request", "the arguments must be a JSON object");
        }
        return await run(args as Record<string, unknown>, { lookup, operationId });
      } catch (error) {
        if (error instanceof DocgenError) {
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  code: error.code,
                  message: error.message,
                  ...(error.problems.length === 0 ? {} : { problems: error.problems }),
                }),
              },
            ],
            isError: true,
            details: { code: error.code },
          };
        }
        throw error;
      }
    },
  }) as unknown as ToolRegistration;
}
