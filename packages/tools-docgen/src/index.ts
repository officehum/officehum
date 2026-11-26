/**
 * @officehum/tools-docgen — the portable document generation pack.
 *
 * Agents make quotes, customer statements, letters, reports, memos and meeting notes in the
 * business's branding: PDF with Typst, Word and Excel through the Paper document worker. Every
 * number comes from the data the caller supplies, checked against the template's JSON Schema, never
 * from the model typing it into a page.
 *
 * It depends on Pi Durable and pi-ai (peers), the SDK, `@officehum/tools-paper-office` and TypeBox,
 * never on a host, so the same pack runs in a bare Pi Durable harness. See README.md.
 */

export {
  type Branding,
  NEUTRAL_BRANDING,
  type ResolvedBranding,
  resolveBranding,
} from "./branding.js";
export {
  type DataProblem,
  DOCGEN_ERROR_CODES,
  DocgenError,
  type DocgenErrorCode,
} from "./errors.js";
export {
  checkData,
  DEFAULT_DOCGEN_LIMITS,
  DOCGEN_POLICY_VERSION,
  type DocgenLimits,
  type DocumentGenerator,
  type DocumentGeneratorOptions,
  documentGenerator,
  MAX_PREVIEW_BYTES,
  type RenderedDocument,
  type RenderRequest,
} from "./generator.js";
export { formatMoney, type Layout, layoutFor, textCell } from "./layouts.js";
export {
  type OverlayTemplateValidatorOptions,
  overlayTemplateValidator,
  type TemplateProblem,
} from "./overlay.js";
export { dataProblems, sampleData } from "./schema.js";
export {
  BUILTIN_TEMPLATES,
  type BuiltinTemplateName,
  builtinTemplates,
  type DocumentTemplate,
  HELPER_FILE,
  overlayTemplate,
  TEMPLATE_FORMATS,
  type TemplateFormat,
  templateCatalog,
} from "./templates.js";
export {
  DOCGEN_PACK_ID,
  DOCUMENT_GENERATE,
  DOCUMENT_TEMPLATES,
  type DocumentGenerationPack,
  type DocumentGenerationPackOptions,
  documentGenerationPack,
} from "./tools.js";
export {
  checkTypst,
  pdfPageCount,
  resolveTypst,
  runTypst,
  runTypstSync,
  TYPST_VARIABLE,
  TYPST_VERSION,
  type TypstJob,
  type TypstOutcome,
  type TypstStatus,
} from "./typst.js";
