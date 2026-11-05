# Office Hum: vision, and the departmental agents

Agreed with Azmat (owner) in a brainstorm on 2026-11-02/03. This document records the product vision and
designs the first body of work: the open-source departmental agents and the research stage that gives
them their knowledge. Where it conflicts with the [2026-10-31 handoff brief](../../handoffs/2026-10-31-handoff-brief.md) or with
[agent-package.md](../../design/agent-package.md), this document wins; the conflicts are listed in
"What this changes".

Items marked **(owner)** are Azmat's decisions. Items marked **(builder's call)** were decided while
writing this and can be revisited.

## Intent

A company of about $10M, say a manufacturer making widgets, wants agents doing real departmental work: one
that watches purchase orders and invoices, catalogues and works them, and talks to the accounting system
and a payments provider; one that buys media and looks for good ad bids; one that answers customers on
email, Twitter or the company's Discord. **(owner)**

Office Hum gives that company two routes to the same agents: **(owner)**

1. **Open source.** Download a departmental agent from the officehum GitHub organisation (or npm), run
   it on Pi Durable, and customise it as much as you like.
2. **officehum.com.** Sign up and get a hosted tenant with the agents set up, configured through a web
   portal and, above all, through the Office Hum agent, without touching a CLI.

Why: Azmat wants to build something on Pi Durable that is **genuinely useful to a real business**, and to
learn by building it. **(owner)**

## Order of work

1. **Phase one: the departmental agents, open source.** Build them, publish them, build awareness.
1.5. **Phase one and a half: the Role Factory as a web form.** A customer describes an agent in a form
   and downloads a generated Pi Durable agent. Built after phase one; exposed to customers when the
   owner decides, possibly not until phase two is done. **(owner)**
2. **Phase two: the officehum.com platform.** The Office Hum agent, tenants and hosting, credits, the
   portal.

The platform launches when it is ready, not when phase one is perfect: "we should launch nonetheless".
**(owner)**

## Goals, non-goals, anti-goals

**Goals**

- Departmental agents a real company can point at its own environment, customise, and get real work out
  of. **(owner)**
- Each agent arrives **knowing its department**: the functions, capabilities, terminology, workflows and
  instructions a practitioner in that role knows. The accounting agent understands what an accounting
  analyst does and how an accounting department works. **(owner)**
- That knowledge is **grounded**: researched from the internet, every fact traceable to a source that
  actually says it. Nothing hallucinated. **(owner)**

**Success for phase one (owner):** people use it. Downloads, stars, likes and engagement on the GitHub
repo, and, more than those, agents that actually help a business.

**Anti-goal (owner):** agents that look nice and do not function. A README that impresses and an agent
that cannot do the department's work is the failure this project exists to avoid.

**Non-goals for phase one:** the officehum.com platform, hosting, the portal, billing, web chat, and
real connectors for every vendor a department might use.

## Product principles

1. **An agent is a template for a departmental role.** How a company crafts it for its department is up
   to the company. **(owner)**
2. **Capabilities are off until the customer turns them on.** Unconfigured, an agent cannot move money or
   send on a channel it has not been given. Once a company supplies the tool, credentials and
   instructions, the agent does the real thing: pays an invoice, places an ad bid, replies on Discord.
   This holds for any tool and any channel. **(owner)**
3. **Nothing is locked.** The customer decides. Approvals, limits and spend caps are **strong defaults**,
   not a floor: every agent ships with them on, and a customer may lower or remove any of them. Office
   Hum may warn ("most businesses keep a person on payments over $X"), but the customer's choice stands.
   **(owner)**
4. **Lowering a guard is an explicit, recorded choice**, made in configuration by the customer, never by
   a prompt or an incoming message, and the board records what each agent did under which
   configuration, so "why did it pay that?" is always answerable. **(builder's call**, offered in the
   brainstorm and not contradicted; it keeps the product's "you can see why" promise without locking
   anything.)
5. **Functional, not pretty.** An agent is not built until it does its department's work on a real
   model. The existing gates stand: scripted evals in CI, a live run on a real model before an agent is
   offered (handoff decision 1), `npm run check` green.

## Phase one: the departmental agents

### The first wave (owner)

| department | role | notes |
| --- | --- | --- |
| Sales | Sales / Account Manager | the template; in flight as PR #78 (epic RASF-3295) |
| Finance | Accounting | the Bookkeeper grows into the department: AP, AR, invoicing, reconciliation, month-end close, expense coding, vendor management, collections |
| Customer service | Customer Support | |
| People | People Ops | |
| Operations | Operations / Project Coordinator | |
| Procurement | Purchasing | |
| Marketing | Marketing | |

Front Desk and Office Manager stay as built. The roster is the one posted on RASF-3294; the "not
money-moving" rule in that issue is superseded by principle 2.

Northwind Facilities Ltd. (`company/default/`) stays as the demo company the agents run against out of
the box. **(owner)** The agents themselves are generic to the department, not to cleaning.

### What a departmental agent contains

The existing package contract ([agent-package.md](../../design/agent-package.md#package-layout)) stands:
`officehum.json`, `AGENTS.md`, `APPEND_SYSTEM.md`, `skills/`, `src/`, `evals/`, `README.md`. Phase one adds
one file and raises the bar on the rest.

**`role.md` (owner).** Every agent has a `role.md` describing the role along many dimensions. The
dimensions **(builder's call** on the list; the owner named actions, terminology, function and helpful
principles):

| section | what it holds |
| --- | --- |
| Function | what the department is for and where it sits in a company |
| Responsibilities and actions | what a practitioner actually does, day to day and periodically |
| Terminology | the department's vocabulary, defined |
| Workflows | the department's processes, end to end, step by step |
| Principles | how a good practitioner works: the judgement calls, the controls, the habits |
| Systems | the software the department typically uses (for accounting: QuickBooks, Xero, NetSuite, bill-pay tools) |
| Decisions that go to a manager | what a practitioner normally escalates, which becomes the default approvals |
| Measures | what the department is judged on (for accounting: days to close, DSO, error rate) |
| Sources | every source cited in the file |

Every claim in `role.md` cites its source, inline, by a reference to the Sources section. `role.md` is
written for people as well as the agent: it is what a developer reads to see what the agent knows and
where that came from.

**`role.md` is the root; the rest is built from it.** Its terminology, workflows and principles become
skills (`skills/<workflow>/SKILL.md` with references). Its actions become the tools. Its manager
decisions become the default approvals, named in the department's vocabulary. Its workflows become eval
scenarios. The agent reads `role.md` through a `department-knowledge` skill (or the existing
`read_skill` path), so it is loaded on demand rather than inflating every prompt. **(builder's call** on
the loading mechanism.)

**Tools fit the department's work, with swappable backends.** Each tool is shaped around a real action
from `role.md` (record a vendor bill, run an aging report, draft a campaign email), not a generic
"create record". Each tool talks to a backend interface the way the Sales agent's `SalesDesk` does: a
demo backend against Northwind so the agent works out of the box, and a seam a company (or a later
connector package) fills with its real system. Real connectors are not a phase-one goal; the existing
QuickBooks and Google Calendar packages are used where they already exist. **(builder's call:** the
owner set department knowledge as the bar, not integrations.)

**Approvals and limits are the role's defaults, in its own words** ("a payment over $X needs the
controller"). Per principle 3 they are defaults the customer can change.

**Evals test whether the agent knows the job:** realistic departmental tasks drawn from `role.md`'s
workflows, scored on executed tool calls and board rows, run scripted in CI and live before release.

**The README** tells a stranger how to install the agent, swap Northwind for their own company, connect a
real backend, and change the defaults.

### The research stage (owner)

Deep research for each departmental role, done for the first wave and **built into the Role Factory** so
that every later role (and, in phase two, the Office Hum agent working for a customer) gets the same
grounding.

```
role name + department
  -> plan: the questions role.md must answer, per section
  -> search: find candidate sources on the web
  -> fetch: download each source; keep the fetched text with its URL and fetch date
  -> extract: draft claims, each tied to the passage it came from
  -> verify: check each claim against the fetched passage; drop any that the passage does not support
  -> write: role.md with inline citations, plus references/sources.json (URL, title, fetch date, the
            supporting passage for each claim)
  -> person review: the owner reads role.md files in one or two batches before those roles are
                   built; Sales work continues meanwhile (owner)
```

Rules:

- **Grounded means verified against fetched text.** A claim is kept only when the passage fetched from
  its cited URL supports it. A dead link, a paywall or a passage that does not support the claim drops
  the claim; it is never softened or kept uncited. **(owner** for "non-hallucinated, grounded facts";
  the mechanism is the **builder's call.)**
- **A validator, separate from the writer.** A `verify-role` check reads `role.md` and
  `sources.json` and confirms that every claim has a citation, every citation has a stored passage, and
  (with network, outside CI) that the URL still serves it. In CI, with no network, it checks structure
  and the stored passages only. **(builder's call**, following the repo's "one writer, a drift test"
  pattern.)
- **Sources prefer authority.** Professional bodies, standards, government guidance, established
  textbooks and vendor documentation over anonymous blogs. A source's kind is recorded in
  `sources.json`. **(builder's call.)**
- **No copying.** `role.md` summarises in its own words and quotes only short passages; the stored
  passages in `sources.json` are evidence for verification, kept short.
- **Tests use recorded fixtures.** The repo's "no network and no real model in tests" rule holds: the
  research pipeline is tested against recorded search results and fetched pages.
- **Where it lives:** a `research` stage in `@officehum/role-factory`, run from the CLI as a build-time
  step (`officehum research <role>`). Its output feeds `ROLE_SPEC.md`
  ([role-spec.md](../../design/role-spec.md)): `role.md` informs the spec's knowledge and wisdom layers,
  and the interview can start from it. **(builder's call.)**

**Order (builder's call):** define the `role.md` format and the `verify-role` validator first. Research
the first-wave roles to that format with the tools available to the building agent today, so the agents
are not blocked on the pipeline. Then build the factory's research stage to produce the same output, and
prove it by regenerating one first-wave `role.md` and comparing.

### The Sales template (PR #78)

The Sales agent stays the template, and it now needs a researched `role.md` too. The building agent
takes over PR #78 and merges it once it meets the "offered" bar. **(owner)** Before merging:

1. Fix the quote tool so code, not the model, picks the price-book item and tier from what was measured
   (square feet, restroom count, visits). The 2026-10-31 brief said the price book had no units; it does,
   and the real failure was the model choosing the flat visit item with a quantity of 32. Make units a
   fixed list the sync validator enforces.
2. Add the researched `role.md` and rebuild skills, approvals and scenarios from it.
3. Re-run live at three trials; read every failing trace before changing a scenario.

Then the other six roles follow the template, each with its own research, review and live run.

## Phase one and a half: the Role Factory as a web form (sketch, not designed here)

A simple app: inputs in, a working agent package out. No tenant, no hosting, no ongoing chat. **(owner)**

- **The form collects the role as the customer sees it (owner):** role metadata (name, department, who
  it reports to), an explanation of the role, its instructions, its skills, the tools it needs, and any
  researched knowledge or "wisdom" the customer brings.
- **Only what the customer provides (owner).** No research on our side. Customer-supplied knowledge goes
  in the generated `role.md`. Where it carries no sources, `role.md` says it was supplied by the customer,
  not researched, so the "grounded" promise for our own agents stays honest. **(builder's call.)**
- **The generator builds the whole package (owner).** From the customer's descriptions it:
  - writes each tool's schema;
  - writes the code in the right places: `defineTool` with `replay` stated, output in `output`, wired
    into the role's extension;
  - writes the configuration (`officehum.json`, approvals, agent configuration);
  - creates the extensions and skills folders and files;
  - makes the repository;
  - offers the customized Pi Durable agent as a download.
- **What a generated tool's body does (builder's call; owner to correct).** Where the customer describes
  behaviour that needs a system we cannot reach at generation time (their ERP, their bank), the body is
  a clearly marked placeholder that refuses with "not connected yet". The agent still runs, and nobody
  is misled into thinking it acts. Where the behaviour is self-contained (a calculation, a lookup in
  data the customer supplied), the generator writes it.
- **Checked before download (builder's call).** The generated package must pass the SDK's package
  validator, typecheck, and its scripted evals. A package that fails is not offered.
- **What it reuses:** the role package format, `role.md`, and the Role Factory's spec and generator,
  extended with a model step that turns plain-language tool descriptions into schemas and code. The
  departmental agents can be starting points on the form.

## Phase two: officehum.com (sketch, not designed here)

What a customer pays for, in the owner's order:

1. **The Office Hum agent.** Always on, not just for setup. The first ten minutes are an onboarding
   interview: it learns the business's requirements, decides which departmental roles they need, creates
   them with the Role Factory, and starts them. After that it stays: the customer's way to build,
   configure and tweak agents by chat, connect tools and channels, and change approvals, with warnings
   where a choice is risky. It runs on **credits**: each customer gets an allowance of tokens for it.
   Prior art: seaBoss's onboarding interview, where the interviewer goes away; here it stays.
2. **Hosting.** A tenant per customer, no servers, no CLI, backups and updates handled. The Vultr,
   Backblaze B2 and Cloudflare choices stand.
3. **One office.** Agents hand work to each other, and approvals and the record of who did what span the
   team.

Plus a web portal where admins see and fine-tune what the Office Hum agent set up. Each of these gets its
own design when phase two starts.

## What this changes

- **Handoff decision 10's "floor".** The brief said the platform guarantees are "the floor, not a default
  the overlay may lower". Superseded by principle 3: they are defaults.
- **Overlay rules in agent-package.md.** "Overlays can switch tools off, never add them" and "limits are
  never removed … switch its approval off … is refused" contradict principles 2 and 3. They are revised
  when phase two designs the configuration surface; phase one does not change the overlay code, since a
  downloaded open-source agent is the customer's to edit anyway. **(builder's call** on timing.)
- **RASF-3294's "not money-moving" rule** is superseded by principle 2. Correct the issue comment.
- **The 2026-10-31 brief** carries two errors to correct: the price-book unit claim, and §8 telling the
  next agent to pick from Streams A or B.

## Settled after the builder check

- **The first-wave agents are hand-written from `role.md`, following the Sales template**, not
  generated through `ROLE_SPEC.md` → `generateRole`. The generator emits tool stubs and cannot write
  the department backends these agents need. In phase one the Role Factory gains only the research
  stage. Extending the generator to produce a whole department agent is later work. **(builder's
  call.)**
- **Publishing** follows handoff decision 7: one public repository and npm packages a stranger can
  install. Docker images come later. Publishing counts only when a stranger can run an agent. The
  first public npm publish is outward-facing and irreversible, so it waits for the owner's go-ahead at
  that moment.
- **Principle 4's configuration record is phase two.** Phase one ships the defaults and the board as
  it is. No change to `@officehum/office`. **(builder's call.)**
- **Money-moving and sending tools ship in phase one where the department needs them** (pay a vendor
  bill, place an ad bid, send a campaign email). Each has a demo backend only and a default approval
  on every call. Each role's `mayNot` loses "move money" where such a tool exists. Its evals check
  that the default approval fires, and that the tool runs once a person approves. **(builder's call,
  following principle 2.)**
- **"Offered" means:** `npm run check` green; scripted evals pass; and a live run on
  `paper/ultramarine-1-flash` at three trials with every critical scenario passing 3/3 and the suite
  at 90% or better overall. Every failure is read in the trace and recorded in the PR. **(builder's
  call; the Front Desk's 8/8 at 3/3 is the precedent.)** The 2026-10-31 handoff brief is copied into
  `docs/handoffs/` so these references resolve.

## Left to the builder

- The search provider and the model used by the research stage, within the repo's rules (Paper by
  default; a provider failure is surfaced, never silently swapped).
- The exact `sources.json` schema and the `role.md` section headings.
- How many skills each role's workflows become, and which backend interfaces each role needs.
- Whether Accounting is a rename and expansion of `agents/bookkeeper` or a new package beside it.
