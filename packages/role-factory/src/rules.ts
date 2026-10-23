/**
 * The four-layer rules a `ROLE_SPEC.md` is held to: **context and knowledge inform the agent; wisdom
 * and workflow control it.** `parseRoleSpec` runs them over the frontmatter and the body, so a spec
 * reports every problem it has, each with the path it sits at and the layer it belongs to — never the
 * first one only.
 *
 * They read unvalidated YAML on purpose. A document with one broken field still answers every other
 * question, and a field the schema has already refused is left to the schema: a rule that cannot read
 * what it needs stays silent rather than reporting the same thing twice.
 *
 * See docs/design/role-spec.md.
 */

import {
  AGENTS_WORDS_MAX,
  AGENTS_WORDS_WARN,
  type AgentManifest,
  type ConditionDeclaration,
  type ContextNumber,
  contextNumbers,
  countWords,
  type FourLayer,
  GENERIC_TOOLS,
  type Issue,
  joinPath,
  limitName,
  RESERVED_TOOL_NAMES,
  SDK_TOOL_NAMES,
  show,
  validateSuite,
} from "@officehum/sdk";

/** The layer a path in a spec belongs to; a path outside the four layers keeps none. */
export function layerForPath(path: string): FourLayer | undefined {
  const at = (prefix: string): boolean =>
    path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
  if (at("context")) return "context";
  if (at("knowledge")) return "knowledge";
  if (at("wisdom")) return "wisdom";
  if (at("workflow")) return "workflow";
  // The role's own fields are not a layer, except the ones the four layers name: the engine the
  // role's facts come from, the limits that gate it, and the tools it works through.
  if (at("role.engine") || at("role.runtimes")) return "knowledge";
  if (at("role.limits")) return "wisdom";
  if (at("role.tools")) return toolFieldLayer(path) ?? "wisdom";
  return undefined;
}

/** The fields of a tool declaration the model reads, as opposed to the ones that control a call. */
const TOOL_KNOWLEDGE_FIELDS = [
  "description",
  "engine",
  "guidelines",
  "parameters",
  "skill",
] as const;

/** Knowledge for what the model reads about a tool, wisdom for the rest of its declaration. */
function toolFieldLayer(path: string): FourLayer | undefined {
  const field = /^role\.tools\[\d+\]\.([A-Za-z]+)/.exec(path)?.[1];
  return field !== undefined && (TOOL_KNOWLEDGE_FIELDS as readonly string[]).includes(field)
    ? "knowledge"
    : undefined;
}

/** A value that is a YAML mapping. */
export function mapping(value: unknown): Mapping | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : undefined;
}

/** The entries of a value that is a list. */
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The text of a value that is a string. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The entries of a value that are mappings, in order; anything else is the schema's to report. */
function mappings(value: unknown): Mapping[] {
  return list(value).filter((entry): entry is Mapping => mapping(entry) !== undefined);
}

export type Mapping = Record<string, unknown>;

/** The path the spec's body is reported at: the context layer, outside the frontmatter. */
export const BODY_PATH = "context (body)";

/** Where a number belongs, said the same way wherever one turns up in the spec's context. */
function numberMessage(found: ContextNumber): string {
  return `${show(found.text)} is ${found.what}; put it in wisdom.approvals[].when, business.settings limits, or a skill reference`;
}

/**
 * Context: the body is the role's AGENTS.md, so it is short and holds no numbers. Nothing here
 * mentions the "You may not" section the four-layer check wants in AGENTS.md: the generator writes
 * that section from `wisdom.authority`, which is where prohibitions and their enforcement live.
 */
export function contextIssues(frontmatter: Mapping, body: string, source: string): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string): void => {
    issues.push({ source, path, message, layer: "context" });
  };

  if (body === "") {
    add(BODY_PATH, "is required: it tells the role who it is, who it reports to and how it works");
  } else {
    const words = countWords(body);
    if (words > AGENTS_WORDS_MAX) {
      add(
        BODY_PATH,
        `is ${words} words; keep the body under ${AGENTS_WORDS_MAX} words and move the detail into a skill's instructions or one of its reference files`,
      );
    } else if (words > AGENTS_WORDS_WARN) {
      issues.push({
        source,
        path: BODY_PATH,
        message: `is ${words} words; the body reads best under ${AGENTS_WORDS_WARN}, so move the detail into a skill or one of its reference files`,
        layer: "context",
        severity: "warning",
      });
    }
    for (const found of contextNumbers(body)) add(BODY_PATH, numberMessage(found));
  }

  const appendSystem = text(mapping(frontmatter.context)?.append_system);
  if (appendSystem !== undefined) {
    for (const found of contextNumbers(appendSystem))
      add("context.append_system", numberMessage(found));
  }
  return issues;
}

/** Knowledge: every reference path is relative to the skill's `references/` folder and stays there. */
export function knowledgeIssues(frontmatter: Mapping, source: string): Issue[] {
  const issues: Issue[] = [];
  const skills = mappings(mapping(frontmatter.knowledge)?.skills);
  skills.forEach((skill, index) => {
    mappings(skill.references).forEach((reference, referenceIndex) => {
      const path = text(reference.path);
      if (path === undefined) return;
      const problem = referencePathProblem(path);
      if (problem === undefined) return;
      issues.push({
        source,
        path: joinPath(
          joinPath(joinPath(joinPath("knowledge.skills", index), "references"), referenceIndex),
          "path",
        ),
        message: problem,
        layer: "knowledge",
      });
    });
  });
  return issues;
}

/**
 * `readSkill` refuses a path that leaves a skill's folder, and the generator writes each reference
 * below `references/`, so a spec may only name a plain relative path inside the skill.
 */
function referencePathProblem(path: string): string | undefined {
  if (path.trim() === "")
    return "is required: a reference is a file under the skill's references/ folder";
  if (path.includes("\\")) return `must use "/" between folders (got ${show(path)})`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return `must be relative to the skill's references/ folder, not an absolute path (got ${show(path)})`;
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    return `must stay inside the skill (got ${show(path)}); a reference never climbs with ".."`;
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    return `must be a plain relative path inside the skill (got ${show(path)})`;
  }
  return undefined;
}

/**
 * Wisdom: what the role may not do and how that is enforced, and the one approval decision every
 * unsafe tool states. `enforced_by` resolves when it names an approval the spec declares; `no_tool`
 * and `person_only` are claims this parser cannot prove, so it accepts them and the generated evals
 * test them (see docs/design/role-spec.md).
 */
export function wisdomIssues(frontmatter: Mapping, source: string): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string): void => {
    issues.push({ source, path, message, layer: "wisdom" });
  };

  const wisdom = mapping(frontmatter.wisdom);
  const authority = mapping(wisdom?.authority);
  const approvals = mappings(wisdom?.approvals);
  const approvalIds = new Set(approvals.map((approval) => text(approval.id)).filter(isText));
  const approvalTools = new Set(approvals.map((approval) => text(approval.tool)).filter(isText));

  if (authority !== undefined && list(authority.may).length === 0) {
    add(
      "wisdom.authority.may",
      'must state at least one thing the role does; the generator writes these as AGENTS.md\'s "You may" list',
    );
  }
  const mayNots = mappings(authority?.may_not);
  if (authority !== undefined && mayNots.length === 0) {
    add(
      "wisdom.authority.may_not",
      "must state at least one thing the role never does, with what it does instead and how that is enforced",
    );
  }
  mayNots.forEach((entry, index) => {
    const enforced = text(entry.enforced_by);
    if (enforced === undefined || !enforced.startsWith("approval:")) return;
    const id = enforced.slice("approval:".length);
    if (approvalIds.has(id)) return;
    add(
      joinPath(joinPath("wisdom.authority.may_not", index), "enforced_by"),
      `names approval:${id}, which is not a declared approval; add it to wisdom.approvals[] or enforce this another way`,
    );
  });

  const tools = mappings(mapping(frontmatter.role)?.tools);
  tools.forEach((tool, index) => {
    const name = text(tool.name);
    const at = joinPath("role.tools", index);
    if (name !== undefined) {
      const generic = GENERIC_TOOLS[name];
      if (generic !== undefined) {
        add(
          joinPath(at, "name"),
          `${show(name)} is a generic ${generic}; a role registers no shell or file tool, so work through the role's declared tools (read_skill reads its references)`,
        );
      }
    }
    const replay = text(tool.replay);
    if (replay === undefined) return;
    const approval = name !== undefined && approvalTools.has(name);
    const note = text(tool.noApproval) !== undefined;
    if (replay === "unsafe" && approval && note) {
      add(
        at,
        `${show(name)} is unsafe and states two approval decisions; keep an approval in wisdom.approvals[], or noApproval, never both`,
      );
    } else if (replay === "unsafe" && !approval && !note) {
      add(
        at,
        `${show(name)} is unsafe and states no approval decision; add an approval in wisdom.approvals[], or a noApproval note saying why it needs none`,
      );
    } else if (replay === "safe" && note) {
      add(
        joinPath(at, "noApproval"),
        `${show(name)} is safe, so noApproval does not apply; remove it (noApproval explains an unsafe tool that needs no approval)`,
      );
    }
  });
  return issues;
}

/**
 * Workflow: nobody talks a status into existence, so every accepted ticket type declares its evidence,
 * and evidence that names a tool names one of this role's safe tools — the host runs it, never the
 * model.
 */
export function workflowIssues(frontmatter: Mapping, source: string): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string): void => {
    issues.push({ source, path, message, layer: "workflow" });
  };

  const replay = new Map<string, string>();
  for (const tool of mappings(mapping(frontmatter.role)?.tools)) {
    const name = text(tool.name);
    if (name !== undefined) replay.set(name, text(tool.replay) ?? "");
  }

  mappings(mapping(frontmatter.workflow)?.accepts).forEach((accept, index) => {
    const at = joinPath("workflow.accepts", index);
    const type = text(accept.type) ?? "this ticket type";
    if (list(accept.done).length === 0) {
      add(
        joinPath(at, "done"),
        `is required for ${show(type)}: a ticket is done only when its evidence checks out — an engine check, a safe tool with expect "found", a file, or { "person": true }`,
      );
      return;
    }
    mappings(accept.done).forEach((entry, doneIndex) => {
      const name = text(entry.tool);
      if (name === undefined) return;
      const evidenceAt = joinPath(joinPath(joinPath(at, "done"), doneIndex), "tool");
      const tool = replay.get(name);
      if (tool === undefined) {
        add(
          evidenceAt,
          `${show(name)} is not a declared tool; completion evidence names a safe tool of this role`,
        );
      } else if (tool !== "safe") {
        add(
          evidenceAt,
          `${show(name)} is unsafe; completion evidence runs a declared safe tool in the host, never the model`,
        );
      }
    });
  });
  return issues;
}

/**
 * Declarations: every name and reference inside the spec, held to what the merged manifest must
 * satisfy. `validateManifest` reports these too, but it stops at the first problem it finds, and a
 * spec is reviewed with every problem at once — the generator still runs it over the merged manifest
 * before it writes a package.
 */
export function declarationIssues(frontmatter: Mapping, source: string): Issue[] {
  const issues: Issue[] = [];
  const add = (layer: FourLayer | undefined, path: string, message: string): void => {
    issues.push({ source, path, message, ...(layer === undefined ? {} : { layer }) });
  };

  const role = mapping(frontmatter.role);
  const wisdom = mapping(frontmatter.wisdom);
  const workflow = mapping(frontmatter.workflow);
  const skills = mappings(mapping(frontmatter.knowledge)?.skills);
  const tools = mappings(role?.tools);
  const approvals = mappings(wisdom?.approvals);

  const duplicate = (
    entries: readonly unknown[],
    key: (entry: unknown) => string | undefined,
    field: string,
    what: string,
    layer: FourLayer | undefined,
  ): void => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const name = key(entry);
      if (name === undefined) return;
      if (seen.has(name)) {
        add(layer, joinPath(field, index), `${what} ${show(name)} is declared more than once`);
      }
      seen.add(name);
    });
  };

  duplicate(tools, (tool) => text(mapping(tool)?.name), "role.tools", "tool", "wisdom");
  duplicate(
    approvals,
    (approval) => text(mapping(approval)?.id),
    "wisdom.approvals",
    "approval",
    "wisdom",
  );
  duplicate(
    mappings(workflow?.accepts),
    (accept) => text(mapping(accept)?.type),
    "workflow.accepts",
    "ticket type",
    "workflow",
  );
  duplicate(
    mappings(workflow?.commands),
    (command) => text(mapping(command)?.name),
    "workflow.commands",
    "command",
    "workflow",
  );
  duplicate(skills, (skill) => text(mapping(skill)?.id), "knowledge.skills", "skill", "knowledge");
  duplicate(
    list(role?.connectors),
    (connector) => text(connector),
    "role.connectors",
    "connector",
    undefined,
  );
  duplicate(
    list(role?.channels),
    (channel) => text(channel),
    "role.channels",
    "channel",
    undefined,
  );

  const declaredSkills = new Set(skills.map((skill) => text(skill.id)).filter(isText));
  const declaredTools = new Set(tools.map((tool) => text(tool.name)).filter(isText));
  const reserved = new Set<string>(RESERVED_TOOL_NAMES);
  const sdkTools = new Set<string>(SDK_TOOL_NAMES);
  const byName = new Map(tools.map((tool) => [text(tool.name), tool]));

  tools.forEach((tool, index) => {
    const at = joinPath("role.tools", index);
    const name = text(tool.name);
    if (name !== undefined && reserved.has(name)) {
      add(
        "wisdom",
        joinPath(at, "name"),
        `${show(name)} is provided by ${sdkTools.has(name) ? "the SDK" : "the Office"}; choose another name`,
      );
    }
    const skill = text(tool.skill);
    if (skill !== undefined && !declaredSkills.has(skill)) {
      add("knowledge", joinPath(at, "skill"), `${show(skill)} is not a declared skill`);
    }
  });

  const declaredLimits = new Set(Object.keys(mapping(role?.limits) ?? {}));
  approvals.forEach((approval, index) => {
    const at = joinPath("wisdom.approvals", index);
    const tool = text(approval.tool);
    if (tool !== undefined && !declaredTools.has(tool)) {
      add("wisdom", joinPath(at, "tool"), `${show(tool)} is not a declared tool`);
    }
    const parameters = mapping(byName.get(tool ?? "")?.parameters);
    list(approval.when).forEach((condition, conditionIndex) => {
      const entry = mapping(condition);
      const conditionAt = joinPath(joinPath(at, "when"), conditionIndex);
      const arg = text(entry?.arg);
      if (arg !== undefined && parameters !== undefined && !(arg in parameters)) {
        add(
          "wisdom",
          joinPath(conditionAt, "arg"),
          `${show(arg)} is not a parameter of ${show(tool)}`,
        );
      }
      const limit =
        entry === undefined ? undefined : limitName(entry.value as ConditionDeclaration["value"]);
      if (limit === undefined) return;
      // A named limit replaces a numeric threshold, so it needs one of the numeric comparisons.
      const op = text(entry?.op);
      if (op !== undefined && !["gt", "gte", "lt", "lte"].includes(op)) {
        add(
          "wisdom",
          joinPath(conditionAt, "value"),
          `names a limit, which needs "gt", "gte", "lt" or "lte" (op is ${show(op)}); use a literal value instead`,
        );
      }
      if (!declaredLimits.has(limit)) {
        add("wisdom", joinPath(conditionAt, "value"), `${show(limit)} is not a declared limit`);
      }
    });
  });

  // An engine tool is data: the manifest builds it from the spec, so its program must be a declared
  // runtime and the tool must say what it does, or the model reads nothing about it.
  const engine = mapping(role?.engine);
  const declaredRuntimes = new Set(
    mappings(role?.runtimes)
      .map((runtime) => text(runtime.name))
      .filter(isText),
  );
  const program = list(engine?.command)[0];
  if (typeof program === "string" && !program.includes("/") && !declaredRuntimes.has(program)) {
    add(
      "knowledge",
      "role.engine.command[0]",
      `${show(program)} must be declared in runtimes, e.g. { "name": ${show(program)}, "version": ">=3.10" }, so hosts know to provide it`,
    );
  }
  tools.forEach((tool, index) => {
    if (tool.engine === undefined) return;
    const at = joinPath("role.tools", index);
    if (engine === undefined)
      add("knowledge", joinPath(at, "engine"), "needs the role's engine to be declared");
    if (text(tool.description) === undefined) {
      add(
        "knowledge",
        joinPath(at, "description"),
        "is required for an engine tool: it is all the model reads about it",
      );
    }
  });
  mappings(workflow?.commands).forEach((_command, index) => {
    if (engine === undefined) {
      add(
        "workflow",
        joinPath("workflow.commands", index),
        "needs the role's engine to be declared",
      );
    }
  });

  return issues;
}

/**
 * What each role concern is, and where the spec declares it. Used to tell a role concern that has
 * been written under `business` where it belongs, and to explain the key rather than calling it
 * unknown.
 */
const ROLE_CONCERNS: Readonly<Record<string, string>> = {
  context: "context",
  evals: "evals[]",
  knowledge: "knowledge",
  role: "role",
  wisdom: "wisdom",
  workflow: "workflow",
  id: "role.id",
  department: "role.department",
  defaultModel: "role.defaultModel",
  runtimes: "role.runtimes",
  engine: "role.engine",
  tools: "role.tools[]",
  limits: "role.limits",
  connectors: "role.connectors",
  channels: "role.channels",
  approvals: "wisdom.approvals[]",
  authority: "wisdom.authority",
  may: "wisdom.authority.may[]",
  may_not: "wisdom.authority.may_not[]",
  skills: "knowledge.skills[]",
  accepts: "workflow.accepts[]",
  commands: "workflow.commands[]",
};

/** Keys only one business's overlay has: the role blocks hold none of them. */
const BUSINESS_KEYS = ["agents_md", "business", "settings"] as const;

/**
 * The issues for a role concern written under `business`, by the path they sit at. `parseRoleSpec`
 * uses them to replace the schema's "is not a known field" for the same key, which says less.
 */
export function businessConcerns(
  frontmatter: Mapping,
): Map<string, { message: string; layer?: FourLayer }> {
  const concerns = new Map<string, { message: string; layer?: FourLayer }>();
  for (const key of Object.keys(mapping(frontmatter.business) ?? {})) {
    const home = ROLE_CONCERNS[key];
    if (home === undefined) continue;
    const layer = layerForPath(home);
    concerns.set(joinPath("business", key), {
      message: `${show(key)} is the role's own; declare it at ${home}, and keep business for the business's name, its AGENTS.md additions and its overlay settings`,
      ...(layer === undefined ? {} : { layer }),
    });
  }
  return concerns;
}

/**
 * Separation: the spec is two documents in one. The role blocks are the package every business gets;
 * `business` is one business's overlay, written beside the package and never into it. A concern in
 * the wrong half is refused, whichever way round it is.
 */
export function separationIssues(
  frontmatter: Mapping,
  source: string,
  concerns: ReadonlyMap<string, { message: string; layer?: FourLayer }>,
): Issue[] {
  const issues: Issue[] = [];
  for (const [path, concern] of concerns) {
    issues.push({ source, path, ...concern });
  }
  for (const block of ["role", "context", "knowledge", "wisdom", "workflow"]) {
    for (const path of businessSpecificPaths(frontmatter[block], block)) {
      const key = path.split(".").at(-1) ?? path;
      const layer = layerForPath(path);
      issues.push({
        source,
        path,
        message: `${show(key)} belongs to one business, not to the role; declare it under business.${key}`,
        ...(layer === undefined ? {} : { layer }),
      });
    }
  }
  return issues;
}

/**
 * Every path in a role block that carries a key only a business's overlay has: the block's own keys,
 * and the keys of what its entries declare. It stops there on purpose — deeper inside a tool's
 * parameters or an eval's stubs, `settings` is a name, not a misplaced concern.
 */
function businessSpecificPaths(value: unknown, block: string): string[] {
  const found: string[] = [];
  const businessKey = (key: string): boolean => (BUSINESS_KEYS as readonly string[]).includes(key);
  for (const [key, child] of Object.entries(mapping(value) ?? {})) {
    if (businessKey(key)) {
      found.push(joinPath(block, key));
      continue;
    }
    if (!Array.isArray(child)) continue;
    child.forEach((entry, index) => {
      for (const entryKey of Object.keys(mapping(entry) ?? {})) {
        if (businessKey(entryKey)) {
          found.push(joinPath(joinPath(joinPath(block, key), index), entryKey));
        }
      }
    });
  }
  return found;
}

/**
 * Evals: the spec's scenarios are the SDK's own eval format, so `validateSuite` checks them — stubs,
 * expected calls and approvals must name what the manifest declares, every declared tool must be
 * stubbed, and a ticket input must be a type the role accepts. Its paths are reported at the spec's
 * own `evals[]`.
 */
export function evalIssues(
  frontmatter: Mapping,
  manifest: AgentManifest | undefined,
  source: string,
): Issue[] {
  if (!Array.isArray(frontmatter.evals)) return [];
  if (frontmatter.evals.length === 0) {
    return [
      {
        source,
        path: "evals",
        message:
          "must state at least one scenario: the generated package carries evals for the role's judgement",
      },
    ];
  }
  if (manifest === undefined) return [];
  const checked = validateSuite({ scenarios: frontmatter.evals }, manifest, source);
  if (checked.ok) return [];
  return checked.issues.map((issue) => ({ ...issue, source, path: evalPath(issue.path) }));
}

/** `scenarios[0].stubs` as the spec writes it: `evals[0].stubs`. */
function evalPath(path: string): string {
  const rest = path.startsWith("scenarios") ? path.slice("scenarios".length) : path;
  return joinPath("evals", rest);
}

const isText = (value: unknown): value is string => typeof value === "string";
