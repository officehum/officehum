/**
 * The overlay check: a business's template must compile with sample data from its own schema before
 * the office accepts the overlay. It plugs into the overlay store's `validators` (structurally; this
 * package never imports a host), which run synchronously on every draft, apply and
 * revert, so the compile here is synchronous and bounded by its time limit.
 *
 * Only the owned overlay's templates are compiled: the layers below it are read-only inputs a
 * business cannot fix from its own overlay.
 */

import type { ResolvedTemplate } from "@officehum/sdk";
import { NEUTRAL_BRANDING } from "./branding.js";
import { dataProblems, sampleData } from "./schema.js";
import { HELPER_FILE, helperSource } from "./templates.js";
import { checkTypst, pdfPageCount, resolveTypst, runTypstSync } from "./typst.js";

export interface OverlayTemplateValidatorOptions {
  /** The Typst binary. Default: `OFFICEHUM_TYPST`, else `typst` on the PATH. */
  readonly typst?: string;
  /** How long one template may take to compile. Default 10 s. */
  readonly timeoutMs?: number;
}

/** One problem, in the overlay store's shape. */
export interface TemplateProblem {
  readonly source: string;
  readonly path: string;
  readonly message: string;
}

/** A validator for `openOverlayStore({ validators: [...] })`. */
export function overlayTemplateValidator(
  options: OverlayTemplateValidatorOptions = {},
): (overlay: {
  readonly layer: string;
  readonly resolved: { readonly templates: readonly ResolvedTemplate[] };
}) => TemplateProblem[] {
  const timeoutMs = Math.min(options.timeoutMs ?? 10_000, 10_000);
  return ({ layer, resolved }) => {
    const own = resolved.templates.filter((template) => template.layer === layer);
    if (own.length === 0) return [];
    const typst = checkTypst(options.typst ?? resolveTypst(process.env));
    return own.flatMap((template): TemplateProblem[] => {
      const problem = (message: string) => [{ source: template.file, path: "", message }];
      if (!typst.ok) return problem(`cannot be checked, so it is not accepted: ${typst.message}`);
      const sample = sampleData(template.schema);
      const mismatches = dataProblems(template.schema, sample);
      if (mismatches.length > 0) {
        return problem(
          `cannot be checked: the sample data from its schema does not match the schema (${mismatches
            .map((entry) => `${entry.path} ${entry.message}`)
            .join("; ")}); give the schema an "examples" entry that matches it`,
        );
      }
      const outcome = runTypstSync({
        binary: typst.binary,
        files: {
          [`${template.name}.typ`]: template.source,
          [HELPER_FILE]: helperSource(),
          "data.json": JSON.stringify(sample),
          "brand.json": JSON.stringify({ ...NEUTRAL_BRANDING, logoFileId: undefined, logo: null }),
        },
        main: `${template.name}.typ`,
        format: "pdf",
        timeoutMs,
      });
      if (!outcome.ok) {
        return problem(`does not compile with sample data from its schema: ${outcome.message}`);
      }
      if (pdfPageCount(outcome.bytes) === undefined) {
        return problem("compiled, but to a PDF whose pages cannot be counted");
      }
      return [];
    });
  };
}
