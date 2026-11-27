# Overlay rules: lowering a default as an explicit, recorded choice

Status: accepted. This note covers what a role relies on: what counts as lowering a guardrail, and
what no overlay can lower. How a host records and acknowledges a lowering is the host's.

## Why

Office Hum treats approvals, limits and spend caps as **strong defaults, not a floor**: a customer
may lower or remove any of them, and lowering one is an explicit, recorded choice, made in
configuration by the customer, never by a prompt or an incoming message, with a record of what each
agent did under which configuration. The overlay rules in
[agent-package.md](agent-package.md#overlays-configuring-a-role-without-changing-it) say the opposite
("overlays can switch tools off, never add them"; a limit's approval cannot be switched off). The
two agree once the rule is that a customer must not be able to **silently** weaken a guarantee. This
document makes them agree:

- an overlay **may** lower any guardrail the role ships, including switching an approval off;
- a lowering is applied only with an **acknowledgement naming that guardrail**, given by an
  authenticated person's own command;
- the version records **what was lowered, the sentence shown, who, when and from which kind of
  session**; and each approval asked, and each call that ran only because a guardrail was lowered,
  records the configuration version it ran under.

What is true today, read from the code (and not quite what the docs say):

- `OverlaySettingsSchema` (`packages/sdk/src/resources.ts`) has no `approvals` field at all, so an
  overlay cannot touch an approval directly.
- An overlay limit is **not** tighten-only: `resolveRoleFiles` accepts any number and only refuses
  `null`. Raising `large_invoice` from 2,500 to 5,000,000 is accepted today with no warning and no
  record beyond the version's author. That is the silent lowering these rules close.
- The approval gate takes `manifest.approvals` once (`defineRole` → `approvalGate({ approvals:
  manifest.approvals, get limits() … })`), so only limits are live.

## 1. What counts as a guardrail, and what counts as lowering it

A **guardrail** is anything in code or manifest data that makes an agent ask a person, stop, or lack a
capability. Prompt text is not a guardrail (AGENTS.md: "Guardrails are code or manifest data, never
prompt text only"), with one deliberate exception below (replacing the role's own instructions),
which is treated as one because it removes the role's "You may not" section.

**The comparison is mechanical and three-way.** For a candidate overlay the store computes three
effective configurations with `resolveRoleFiles`: the **defaults** (the package alone, no
overlays: what the role ships with), the **current** one (the package and the overlays in effect) and the **candidate** (the same with the draft as the
owned overlay). For every guardrail it records whether the candidate is looser than current and looser
than the defaults. Only a change that is **looser than both** needs an acknowledgement: moving a
guardrail further below what the role ships with than it is now. Restoring a guardrail to its shipped
default, or tightening anything, never does. A lowering already made in an input overlay is part of
current, so the owned overlay is not charged for it again; it is reported with its own source
(section 3, "Imports"). No model is involved.

Each guardrail change gets a stable **id** (`<kind>.<name>`), an **effect** and a **sentence** naming it in plain words, rendered by the server from the template
in the table (section 6 has the full copy). The effect is one of four, and only `lowers` needs an
acknowledgement:

- `lowers`: looser than the version in effect, and looser than the default;
- `loosens`: looser than the version in effect, but still tighter than the default (a business
  easing back a guardrail it had tightened);
- `tightens`: tighter than the version in effect, and not back at the default (this includes a
  guardrail that is still lowered, only less);
- `restores`: back at the default.

| Guardrail | Lowering it | How the diff detects it | id | Sentence template (draft) |
| --- | --- | --- | --- | --- |
| **Approval** (`approvals[]` in `officehum.json`) | Switching it off. An approval on a tool declared `outside` is a hard floor for now (section 2). | New `settings.json` field `approvals`, an edit list like `tools`: `"-pay_bill_over_limit"` off, `"+…"` back on. An approval in the defaults' effective set that is absent from the candidate's. | `approval.<id>` | "Stop asking a person before: {description}. {Agent} will do this on its own." |
| **Approval threshold** | Raising a limit an approval compares with `gt`/`gte`, or lowering one it compares with `lt`/`lte`. | Overlays cannot edit an approval's `when` (see below), so a threshold moves only through a named limit. The limit's direction comes from the conditions that reference it (`gt`/`gte` → a **ceiling**, raising loosens; `lt`/`lte` → a **floor**, lowering loosens; a limit compared both ways → any change loosens; `validateManifest` already allows a limit only with those four ops). A limit referenced only by code conditions takes its direction from a new optional manifest field `limits.<name>.guard` (below); without one, any change counts as loosening. | `limit.<name>` | 'Raise "{description}" from {current} to {new}; the role ships with {default}.' ("Lower" when the number goes down.) For a limit of unknown direction it adds: "Office Hum cannot tell which way is safer for this limit, so it treats any change as lowering a guardrail." |
| **Limit removed** | Not possible. | `null` stays refused, with a new message: "to stop asking, switch the approval off". Removing a limit would leave an approval with nothing to compare (it fails safe and asks every time), so the explicit, named way to stop asking is switching the approval off. | — | — |
| **Approval condition narrowed** | Not possible by overlay. | `when` stays package data. A literal threshold the business needs to change is a role defect: the role should declare a limit. The free roles already do for money; strict mode could later require it (not decided yet). | — | — |
| **Tool switched on** that the role ships off | A **writing** tool (`replay: "unsafe"` or `writes: true`) becoming available that is not available in the defaults. | Available tools = declared tools whose skill (if any) is enabled, minus `disabledTools`. Today a tool ships off only by belonging to a skill with `enabledByDefault: false` (no free role has one yet, but the rule is general). A safe (read-only) tool switched on is not a guardrail change. Switching a tool off, or back on to its default, is not a lowering. | `tool.<name>` | "Switch on {tool}, which {Agent} ships switched off. It changes things, and {its approval "{x}" still applies \| no approval covers it}." |
| **Tool the role does not declare** | — | Still refused: overlays never add a tool. See below. | — | — |
| **Skills** (switch on or off, replace, add) | Not a guardrail. | Skills are instructions and references only; an overlay skill cannot carry code. Switching on a skill that carries writing tools is caught by the tool row above. | — | — |
| **`AGENTS.override.md`** (replaces the role's `AGENTS.md`) | Adding one where the current version has none. | The candidate's effective `agents` no longer contains the package's `AGENTS.md` source while the current one does. Editing an existing override, or removing it, needs nothing. | `instructions.agents` | "Replace {Agent}'s own instructions, including what it says it must never do, with yours. Its approvals and limits still apply." |
| **`APPEND_SYSTEM.md`** replacing the package's | Adding one where the package has one and the current version does not override it. | Effective `appendSystem.source` moves off the package's file. | `instructions.append_system` | "Replace the closing instructions {Agent} ships with. Its approvals and limits still apply." |
| **Model, provider, thinking level** | Not a guardrail. | Guardrails are code and run the same on any model. The model catalog (`list_models`) is the floor: an overlay may pick only a tested model, and a provider failure is never silently swapped. Recorded as an ordinary change. | — | — |
| **Working hours** | Not an overlay setting. | Out of scope. | — | — |
| **Practice mode** | Not an overlay setting. | A host's own setting. | — | — |
| **Per-ticket budgets** | Not an overlay setting. | A host's own setting. | — | — |

**Limit direction for code-only limits.** Ten of the fifteen free roles have limits read only by
code (`collections_first_days`, `inspection_pass_score`, `fatality_report_hours`,
`purchase_order_limit_cents` …). Some are guardrails in one direction, some are schedule parameters.
Rather than guessing, `LimitDeclaration` gains an optional `guard: "ceiling" | "floor" | "none"`:

- `ceiling`: raising it loosens a guardrail (`purchase_order_limit_cents`);
- `floor`: lowering it loosens one (`inspection_pass_score`);
- `none`: not a guardrail (`collections_first_days`); changing it never needs an acknowledgement.

`validateManifest` refuses a `guard` that contradicts a condition referencing the limit (`gt` with
`floor`, say). A limit referenced by a manifest condition needs no `guard`. A code-only limit
without one is treated conservatively: any change is a lowering. A role PR declares `guard` for
every code-only limit in `agents/*/officehum.json`. It is manifest data the model never sees.

**Why overlays still never add a tool the role does not declare.** Recommendation: keep the rule.

1. **A tool is code.** An overlay holds only instructions and data (skills are instructions-only,
   "no shell or file-writing tools in roles"). A tool an overlay "adds" would need code from
   somewhere, which is the vetted-package path (`tool-sources.md`: a vetted role or tool pack
   release).
2. **Replay and approval are declared with the tool.** Every tool states `replay` in code and
   manifest, and every writing tool states an approval decision (`checkAgent`). An overlay-added
   tool would carry none of that review.
3. **Capabilities are already off until the customer turns them on.** That is
   satisfied by switching on a declared tool, a connector grant (`set_grants`), or installing a
   tool pack. None needs overlay-added tools.

So the existing refusal stays, with clearer wording: `"issue_refund" is not a tool of this role;
an overlay switches a role's tools on or off, and new tools arrive in a role or tool pack release`.

## 2. What no overlay can lower (hard floors that stay code)

These are not defaults. No settings field reaches them, and the schema (`additionalProperties:
false`) refuses any attempt.

| Floor | Where it lives | Why it is not a default |
| --- | --- | --- |
| With no approver supplied, a gated action is refused. | `approvalGate` in `packages/sdk/src/approvals.ts`; practice mode's same rule. | AGENTS.md hard rule. An overlay may switch an approval off, so the action is no longer gated. It can never make "gated, and nobody to ask" pass. |
| Conditions fail safe (a missing argument or an unresolved limit counts as met). | `conditionsHold`, `summedField`. | It is how a guardrail behaves, not where it sits. Lowering it would make every guardrail unreliable, not one guardrail lower. |
| Approved facts and values bind the call; forged reserved arguments are stripped. | `APPROVED_FACTS_ARG`, `APPROVED_VALUE_ARG`, `RESERVED_ARGS`. | This protects what a person approved. It is not a policy choice. |
| Replay declarations. | `defineTool({ replay })`, `officehum.json`. | Pi Durable correctness (AGENTS.md: every tool states `replay`, and they match). Not a policy. |
| Overlays never add a tool, never add code, no shell or file tools. | `resolveRoleFiles`, `readSkill({ instructionsOnly })`, `checkFourLayers`. | AGENTS.md hard rules. This is also why money movement exists only where a vetted role ships a tool for it: an overlay cannot create one. |
| What an agent may reach in an app. | The host's own grants. | An overlay cannot widen what an agent may reach in an app. |
| Who may approve. | The host's approver. | This is who the guardrail asks, not the guardrail. |
| Provenance, the approvals audit, overlay history and the lowered-guardrail record itself. | The host's records. | Seeing why an agent acted depends on them, so they cannot be a setting. |
| The acknowledgement mechanism. | The host (section 3). | It is the thing that makes a lowering explicit. |
| **An approval on a tool that reaches people outside the business**, any limit such an approval compares with, and any limit marked `outside` (loosening it lets an outside tool act without a person, as purchasing's order limit does). None may be loosened past its default. A role declares such a tool with `outside: true` in `officehum.json` (it sends or publishes: email, SMS, posts, purchase orders to a supplier, reports to a regulator). The SDK's `SEND_TOOLS` (`send_message`, `reply_message`) count as outside whether declared or not, and the catalog test holds every catalog role to declaring them, so the floor and the channel check never disagree. | `resolveRoleFiles` refuses the overlay, whatever is acknowledged: "sending to customers without a person reading it first is not available yet". | **A conservative default; whether it can be lowered is not decided yet.** It may become an ordinary acknowledged lowering later. Until then it stays code. |
| Outside content is framed as data. | `outside-output.ts`, MCP and CLI framing. | It protects the model's inputs. It is not a guardrail on an action. |
| Model catalog; no silent provider fallback; secrets never reach engines. | `list_models`, `reserved-env.ts`, engine env. | AGENTS.md hard rules ("Models", "Secrets"). |
| Practice mode and per-ticket budgets. | The host. | Not overlay settings (section 1). Unchanged. |

## 3. The acknowledgement mechanism

What a role relies on from its host, whichever host it is:

- **The comparison is the SDK's.** `guardChanges` and `loweredGuards` say, mechanically, which guardrails
  a candidate overlay lowers below the role's defaults and below the configuration in effect. A host
  never judges it.
- **A lowering is applied only with an acknowledgement naming that guardrail**, given by an authenticated
  person's own command. There is no "acknowledge all", and nothing a model, a message or an incoming
  email says can supply one.
- **The record says what was lowered**, the sentence shown, who acknowledged it and when, and every
  approval asked and call made afterwards records the configuration it ran under.
- **Where nobody acknowledges**, as in `officehum run --overlay DIR` with your own files, the role
  loads and says what is lowered, so a result is never mistaken for one on the role's defaults.
