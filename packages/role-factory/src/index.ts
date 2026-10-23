/**
 * `@officehum/role-factory`: the Role Factory's `ROLE_SPEC.md` — the one reviewable document a role is
 * generated from, organised by the four layers — with `parseRoleSpec`, the parser that validates it and
 * reports every problem at once, each with the path it sits at and the layer it belongs to, and
 * `generateRole`, which compiles a parsed spec into a complete Pi Durable role package.
 *
 * A spec is one document: YAML frontmatter holding the role's identity and capabilities, its context,
 * knowledge, wisdom and workflow, its eval scenarios and one business's specifics; then a body, which
 * is the role's AGENTS.md. The fields the spec shares with `officehum.json` keep the manifest's names,
 * so `manifestFromRoleSpec` is a merge, not a translation. `wisdom.authority` is not a manifest field:
 * `generateRole` turns it into the "You may" and "You may not" sections of AGENTS.md (and into the
 * manifest's `mayNot`), and `business` is written to an overlay, never to the package. The one thing
 * this package does not do is the interview that writes a spec (RASF-3096).
 *
 * See docs/design/role-spec.md.
 */

export {
  type GeneratedRole,
  type GenerateRoleOptions,
  generateRole,
  RoleGenerationError,
} from "./generate.js";
export { BODY_PATH } from "./rules.js";
export {
  type BusinessDeclaration,
  EVALS_DIR,
  manifestFromRoleSpec,
  parseRoleSpec,
  ROLE_SPEC_FILE,
  ROLE_SPEC_SCHEMA_VERSION,
  type RoleBlockDeclaration,
  type RoleSpec,
  type RoleSpecFrontmatter,
  RoleSpecSchema,
  type SkillDeclaration,
  type WisdomDeclaration,
  type WorkflowDeclaration,
} from "./spec.js";
