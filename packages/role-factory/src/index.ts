/**
 * `@officehum/role-factory`: the Role Factory's `ROLE_SPEC.md` — the one reviewable document a role is
 * generated from, organised by the four layers — and `parseRoleSpec`, the parser that validates it and
 * reports every problem at once, each with the path it sits at and the layer it belongs to.
 *
 * A spec is one document: YAML frontmatter holding the role's identity and capabilities, its context,
 * knowledge, wisdom and workflow, its eval scenarios and one business's specifics; then a body, which
 * is the role's AGENTS.md. The fields the spec shares with `officehum.json` keep the manifest's names,
 * so `manifestFromRoleSpec` is a merge, not a translation. `wisdom.authority` is not a manifest field:
 * the generator (RASF-3099) turns it into the "You may" and "You may not" sections of AGENTS.md, and
 * `business` is written to an overlay, never to the package.
 *
 * This package is the format and the parser only; running an interview or writing a package is not its
 * work. See docs/design/role-spec.md.
 */

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
