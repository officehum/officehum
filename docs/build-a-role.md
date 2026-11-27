# Build a role

A role is one job in a business, packaged as a portable Pi Durable agent: its instructions, its
tools, the actions it must ask a person about, and an eval suite. This page covers the package, the
manifest, `defineRole`, engines, overlays, evals, the checks, and the Role Factory that writes a
package from a spec. The full contract is [agent-package.md](design/agent-package.md); this page
links into it rather than repeating it.

Everything here is built. Commands are run from the root of a clone (see the
[quickstart](quickstart.md) for the install), and `npx officehum` assumes you ran
`npm rebuild @officehum/cli` after the build.

## What makes it portable

A role package depends on Pi Durable, pi-ai and pi-schema as **peer dependencies** (`1.6.x`) and on
`@officehum/sdk`, never on a host or on `@officehum/cli`. It installs into any Pi Durable
harness, and its evals must pass in a bare harness with nothing of Office Hum installed. Office Hum
runs, coordinates and configures roles; it never changes one.

A role is kept in four layers, and the SDK checks they stay apart (`checkFourLayers`):

| Layer | Where it lives |
| --- | --- |
| Context: who the role is and how it works | `AGENTS.md` (under 1,000 words, with a "You may not" section and no amounts, percentages or thresholds) |
| Knowledge: reference material | `skills/<id>/references/` |
| Workflow: how a task is done | `skills/<id>/SKILL.md` |
| Wisdom: what it may and may not do | `officehum.json` tools, approvals and limits, enforced by code |

## The package layout

```
agents/my-role/
  package.json          peerDependencies: @earendil-works/pi-durable, pi-ai, pi-schema 1.6.x
  officehum.json        tools (each "safe" or "unsafe" to rerun), approvals, limits, accepts, skills, evals
  AGENTS.md             the role: who it is, what it does, how it works, house style
  APPEND_SYSTEM.md      rules appended to the end of the system prompt
  role.md               optional: the researched description of the job, every claim cited
  role.sources.json     the sources behind role.md
  skills/<id>/SKILL.md  Agent Skills format, read on demand with read_skill
  src/index.ts          the tools, then defineRole(...)
  evals/                scenarios with expected outcomes
  evals.smoke.json      the turns a scripted model plays back, so the evals run with no key
```

The smallest catalog role is the Office Manager ([`agents/office-manager`](../agents/office-manager/)):
no tools, two accepted ticket types, three skills. Its whole entry point is:

```ts
import { fileURLToPath } from "node:url";
import { type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };

export default function officeManager({ overlays }: { overlays?: readonly string[] } = {}): DefinedRole {
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    ...(overlays === undefined ? {} : { overlays }),
  });
}
```

## The manifest

`officehum.json` is data the host reads before any role code runs. Its JSON Schema is
[`packages/sdk/schema/officehum.schema.json`](../packages/sdk/schema/officehum.schema.json), and
every field is described in [agent-package.md](design/agent-package.md#officehumjson). The fields
that carry the rules:

- **`tools`**: every tool the role has, each with `replay` written out. `"safe"` means an interrupted
  call may be run again (it reads, or it is idempotent); `"unsafe"` means it is never rerun after a
  crash. A tool that changes something and is safe to rerun says `"writes": true`. A tool that sends
  or publishes to people outside the business says `"outside": true`. A tool the host supplies from
  a tool pack, such as the data pack's `data_query`, says `"pack": "data"` and a `description`; the
  package has no code for it ([pack tools](design/agent-package.md#pack-tools)).
- **`approvals`**: which calls wait for a person, optionally only `when` conditions over the call's
  arguments hold. Every tool that writes states exactly one approval decision: an approval, or a
  `noApproval` note saying why it needs none.
- **`limits`**: every amount the business may set, by name. A condition compares against
  `{ "limit": "name" }`, never a figure written in the prompt.
- **`accepts`**: the ticket types the role takes from colleagues, each with `done`, the completion
  evidence the host checks before a ticket counts as finished (a read-only tool, an engine check, a
  file, or `{ "person": true }`).
- **`dispatches`**: the ticket types it hands to others, and when.

## `defineRole`

`defineRole` turns the package's files and your tools into Pi Durable extensions and an agent
configuration ([the entry point](design/agent-package.md#the-entry-point)). A role with a tool and
an approval condition, from the SDK's
[`sample-desk`](../packages/sdk/fixtures/sample-desk/src/index.ts) test fixture:

```ts
const bookAppointment = defineTool({
  name: "book_appointment",
  description: "Book an appointment that check_schedule showed as free.",
  parameters: obj({ start: str({ description: "Start time" }), customer: str({ description: "The customer" }) }, { open: true }),
  replay: "unsafe",
  execute: async (args) => {
    const booking = await options.calendar.book(args.start, args.customer);
    return { output: [{ type: "text", text: `Booked ${booking.id} for ${args.start}` }] };
  },
});

return defineRole({
  packageDir: fileURLToPath(new URL("..", import.meta.url)),
  manifest,
  overlays: options.overlays,
  approve: options.approve,
  tools: [checkSchedule, bookAppointment],
  when: { book_after_hours: (args) => Number(String(args.start).slice(11, 13)) >= 18 },
});
```

Rules that matter when you write one:

- A tool result uses `output`, not `content`.
- `replay` in code and in `officehum.json` must match; loading refuses a mismatch.
- The app a tool works in (a calendar, QuickBooks, a desk) is a factory option, so a host passes the
  real one and a test passes a fake.
- With no `approve` supplied, every gated call is refused. A role cannot make "gated, and nobody to
  ask" pass.
- No shell or file-writing tools. A figure the role states comes from a tool or an engine, never from
  the model's arithmetic.
- Who is asking comes from the host as a verified sender, never from a tool argument or the message
  text ([who is asking](design/agent-package.md#the-entry-point)).
- A role that declares pack tools takes `packs` as a factory option and passes it on:
  `defineRole({ ..., packs: options.packs })`. The host builds the pack; the role never depends on
  it, and without it the role loads with those tools absent. A pack tool is reviewed and evaluated
  like any other: its replay, its approval decision, and a skill saying when to use it.

## Engines

When a role must never produce a number itself, its figures come from an **engine**: a command-line
program the role's tools call, declared in the manifest
([engines](design/agent-package.md#engines-a-roles-deterministic-core)). A tool with `engine` has no
code: `defineRole({ engine })` builds it from the manifest. The engine prints one JSON object
(`{ "ok": true, "data": …, "findings": [...] }` or `{ "ok": false, "error": "…" }`), reads input
from `OFFICEHUM_DATA_DIR`, writes only `OFFICEHUM_WORK_DIR`, gets a stable
`OFFICEHUM_IDEMPOTENCY_KEY` per call, and sees no model key or connector token. Its program must be
listed in `runtimes`, so every host checks it is installed before loading the role. In tests and
evals the engine is `stubEngine`.

## Overlays: changing a role without editing it

An overlay is a directory with the package's layout that sits on top of it, lowest first: your
`AGENTS.md` additions, an `APPEND_SYSTEM.md`, new or edited skills, document templates, and a
`settings.json` ([overlays](design/agent-package.md#overlays-configuring-a-role-without-changing-it)):

```json
{
  "defaultProvider": "paper",
  "defaultModel": "ultramarine-1-flash",
  "skills": ["+vip-customers", "-collections"],
  "tools": ["-send_reminder"],
  "approvals": ["-any_payment"],
  "limits": { "large_invoice": 2500 }
}
```

An overlay can switch declared tools and approvals off or back on and set a declared limit. It can
never add a tool, add code (overlay skills hold instructions and reference files only), or remove a
limit.

**Lowering a guardrail is recorded.** A role's approvals, limits
and tools are strong defaults, and which changes lower one is computed by code (`guardChanges`,
`loweredGuards`), not judged. On its own, the role loads and says what is lowered. Run against the
Bookkeeper with an overlay that switches its payment approval off, the eval runner prints:

```sh
mkdir -p .officehum/overlay-test
echo '{ "approvals": ["-any_payment"] }' > .officehum/overlay-test/settings.json
npx officehum eval agents/bookkeeper --model scripted --overlay .officehum/overlay-test --tag smoke
```

```text
Overlays: .officehum/overlay-test (a result under a business's overlays, not on the role's defaults)
Accounting runs with 1 guardrail lowered below its role's defaults:
  approval.any_payment: Accounting does not ask a person before: Approve paying this supplier bill ...
```

A host decides who may apply a change that lowers a guardrail; each lowering is named, and none can
be acknowledged in bulk ([the acknowledgement mechanism](design/overlay-rules.md#3-the-acknowledgement-mechanism)).

**The hard floor** is what no overlay reaches, acknowledged or not
([section 2 of overlay-rules](design/overlay-rules.md#2-what-no-overlay-can-lower-hard-floors-that-stay-code)):
a gated action with no approver is refused; conditions fail safe; an approval binds the exact call a
person saw; replay declarations; no added tools or code; connector grants; who may approve; the
audit and provenance records; and, for now, every approval on a tool that reaches people outside the
business, and any limit such an approval compares with, cannot be loosened past its default. Whether
that last floor can be lowered is not decided yet.

## Evals

Each file in `evals/` holds scenarios: an input (a message, or a ticket), stubs for every declared
tool, the person's scripted answer to each approval, and what must and must not happen
([evals](design/agent-package.md#evals)). Every tool is stubbed, so an eval never touches a real
system.

```sh
npx officehum eval agents/frontdesk --model scripted  # bare harness, no key
npx officehum eval agents/frontdesk                   # live, on the role's default model
```

- **The bare harness.** Every run is on a fresh in-memory Pi Durable harness with only the role's
  own extensions: the portability check. A scenario whose input is a ticket needs a host with a board
  to deliver it, so the bare harness does not run it and the report says so.
- **Critical and normal.** A `critical` scenario must pass every graded trial. `normal` scenarios
  count toward the suite's pass rate (90% by default). A trial the model provider failed is retried
  and, if it never finishes, reported `errored`, counted neither way.
- **Scripted and live.** `--model scripted` plays back `evals.smoke.json`: it checks the wiring and
  costs nothing, and it is what CI runs. Only a live run shows how the model behaves; it ends with
  one line of token usage and estimated cost. Three trials is a smoke test; offering a role needs
  each critical scenario at 20 of 20
  ([how many trials](design/agent-package.md#how-many-trials-what-a-live-pass-does-and-does-not-show)).
- **`--overlay DIR`** (repeatable) runs the same suites under a business's overlays, as shown above.
- **Pack tools.** A suite that uses a tool pack declares `"packs": ["data"]` and stubs the pack's
  tools; `--pack data` gives the role the pack, its tools stubbed, and a run without it skips the suite
  and says so. Other suites need not stub pack tools.

The exit code is `0` passed, `1` failed, `2` usage error, `3` incomplete (repeat the run).

## The checks

Loading a role refuses, naming every problem at once, a package that fails `validatePackage` (the
manifest, the files and the four layers), a Pi Durable peer range that excludes the version the
runner is built against, a missing runtime program (`checkRuntimes`), and code that disagrees with its manifest
(`checkAgent`).

`officehum verify-role ROLE_DIR` checks `role.md` against `role.sources.json`: every claim cited,
every citation sourced, every source used. `--online` also fetches each source and reports a claim
whose quoted passage is not on the page.

```sh
npx officehum verify-role agents/sales
```

```text
officehum.json › tools[3]: warning: "create_quote" changes something and mentions "send"; if it sends or publishes to people outside the business, declare "outside": true so no overlay can switch its approval off
...
role.md OK
```

## The Role Factory

`@officehum/role-factory` writes a role package from one reviewable document, `ROLE_SPEC.md`, so a
role's rules are reviewed as a spec rather than as code ([role-spec.md](design/role-spec.md)). Run
`npm rebuild @officehum/role-factory` once to link `officehum-role`.

```sh
npx officehum-role interview my-role.md      # asks the questions in the terminal and writes a spec
npx officehum-role generate packages/role-factory/fixtures/sample-notes/ROLE_SPEC.md .officehum/sample-notes
```

```text
wrote 11 files to .officehum/sample-notes
  AGENTS.md
  APPEND_SYSTEM.md
  README.md
  evals/generated.json
  ...
  officehum.json
  package.json
  skills/note-house-style/SKILL.md
  src/index.ts
  src/role.test.ts
```

`generate` writes the manifest, the prompt files, the skills, a critical scenario for every approval
(the call is made, the approval asked and declined, and nothing runs), and a test. Change the spec
and regenerate rather than editing the package. A generated package is TypeScript source
(`"main": "./src/index.ts"`): compile it the way the catalog roles do (a `tsconfig.json` and a
`build` script, as in `agents/office-manager`) before `officehum run` or a host loads it.

## Use a role in your own harness

Inside this repository every role is a workspace, imported by name. Nothing is on npm yet, so to use
a role in another project, pack it together with `@officehum/sdk` and install the tarballs with Pi
Durable and its peers:

```sh
npm pack -w @officehum/sdk -w @officehum/frontdesk --pack-destination ../tarballs
cd ../my-harness
npm install ../tarballs/officehum-sdk-0.0.0.tgz ../tarballs/officehum-frontdesk-0.0.0.tgz \
  @earendil-works/pi-durable@1.6.0 @earendil-works/pi-ai@1.6.0 @earendil-works/pi-schema@1.6.0 @earendil-works/pi-mcp@1.6.0
```

Then install the role's extensions and give a conversation its agent:

```ts
import frontdesk from "@officehum/frontdesk";

const role = frontdesk({ calendar, approve });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

Two roles on one harness can hand work to each other with the SDK's local board; see
[agents/README.md](../agents/README.md#two-roles-on-your-own-harness). A role whose package pulls in
another Office Hum package (the Bookkeeper needs `@officehum/quickbooks`) needs that one packed too.
