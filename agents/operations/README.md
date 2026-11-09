# Operations

A portable role package: the operations coordinator at **Northwind Facilities**, a fictitious
commercial cleaning and building-maintenance company in Portland, Oregon. It keeps the field crews'
schedule: which crew goes to which job on which day, inside each crew's weekly hours. It moves one-off
jobs, records call-outs, and hands overtime, a change to a recurring contract, subcontracting and
sign-off to the person who owns them.

It ships with the company's facts — the crews and their weekly hours caps, the staff policies, who
decides what — as a generated skill inside the package. Two things it will not do: put a crew past
its weekly hours cap without a person, and move a visit on a recurring contract without a person.

## Try it

From a checkout of this repository:

```sh
npm install
npm run build
node packages/cli/dist/index.js run agents/operations --model paper/ultramarine-1-flash
```

With no configuration the role runs on a **demonstration desk**: the company's four crews, the week
of Monday 9 November 2026 in memory (its clock starts on that Monday, so "this week" has work in it),
and nothing written anywhere. Ask it to put the Central crew on the Riverside Dental deep clean on
Thursday and it will find their week is full and ask a person for the overtime. It needs a model key in
the environment (`PAPERINSTRUMENTS_API_KEY` for Paper) for that conversation, like every role.

## Run its evals

The scenarios live in `evals/situations.json`; the turns a scripted model plays back are in
`evals.smoke.json`:

```sh
officehum eval agents/operations --model scripted
officehum eval agents/operations --model scripted --mode office   # the office's real approval gate
```

Ten scenarios. Four are critical: overtime refused by the desk, asked for, and declined by a person,
with the client told plainly; a contract visit moved only once a person approves; an instruction
injected into a crew lead's message; and a call-out receipt claiming a person decided, which the reply
must not repeat. Six are normal: a billing request handed to the team that owns it, an assignment
inside the cap, a one-off job moved, a crew's hours answered from the desk, a subcontract handed to the
Operations Manager, and a request to sign off a job handed to the same person.

## What it does

| Tool | Replay | Gate | What it is for |
| --- | --- | --- | --- |
| `list_jobs` | safe | — | The schedule, by date, crew or client: hours, crew, one-off or contract visit |
| `list_crews` | safe | — | Each crew's week: hours booked, cap, approved overtime, hours left, time off |
| `assign_crew` | unsafe | `noApproval`; the desk refuses past the cap, on time off, or a different crew on a contract visit | Put a crew on a job |
| `request_overtime` | unsafe | approval `overtime`, every call | Overtime so a crew can take a job its cap cannot hold |
| `reschedule_job` | unsafe | `noApproval`; the desk refuses a contract visit | Move a one-off job |
| `request_contract_reschedule` | unsafe | approval `contract_reschedule`, every call | Move a visit on a recurring contract |
| `record_callout` | unsafe | `noApproval`: an internal record | Record a call-out request; it books nothing |
| `read_company` | safe | — | One section of the company record, including the crews and staff policies |

Every hours figure comes from the desk: the booked hours of a crew's week (Monday to Sunday), whether a
job would take it past its cap, and the overtime that would need. The caps are the company's
`crews[].weeklyHoursCap`; there is no hours constant in the code. When `assign_crew` is refused for the
cap, the refusal states the overtime hours and names `request_overtime`; `request_overtime` refuses any
other figure, so the person approving sees exactly what the job needs.

A visit on a recurring contract keeps its crew: `assign_crew` refuses a different one, and the refusal
says to hand it to the person the handbook names for scheduling. Approved overtime belongs to its crew and job: if the job
moves to another week or another crew, the overtime no longer counts toward the old week.

There is no tool to subcontract, to mark a job approved or complete, or to book a call-out: those are
for the person the handbook names for scheduling, and the manifest's `mayNot` says so.

### Overtime and the company's setting

The company records `staffPolicies.overtimeNeedsApproval`. It is `true` here, and `request_overtime`
asks a person on every call. The approval is unconditional in `officehum.json`;
`src/package.test.ts` fails if the company setting changes, so the two are revisited together.

## Bind it to a real schedule

The role ships no field-service connection. `fakeOperationsDesk` is the demonstration one; a host
binds an `OperationsDesk` (`src/desk.ts`): `listJobs`, `listCrews`, `assignCrew`, `requestOvertime`,
`rescheduleJob`, `requestContractReschedule` and `recordCallout`. Every write carries a `requestId`
derived from the durable call identity, so a retried call returns what it already did. The desk owns
the hours arithmetic and the refusals; a refusal is an `OperationsDeskError` with a `code` the tools
turn into the next step.

```ts
import operations from "@officehum/operations";

const role = operations({ desk, approve, overlays: ["./my-operations"] });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

- **`desk`** — the schedule. Omitted: the demonstration desk, on the company's own crews.
- **`company`** — a host's own company facts, in the shape of `references/facts.json`.
- **`approve`** — decides the gated actions. Omitted: overtime and a contract move are both blocked.
- **`overlays`** — the business's own `AGENTS.md`, skills and `settings.json`, lowest first.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: eight tools, two approvals, dispatches, `mayNot`, skills, evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `role.md`, `role.sources.json` | The researched description of the job; `officehum verify-role agents/operations --online` re-checks the sources |
| `src/index.ts` | The factory |
| `src/tools.ts` | The eight tools, and the receipts they return |
| `src/company.ts` | The company facts as the role reads them |
| `src/desk.ts` | The `OperationsDesk` interface, `fakeOperationsDesk` and the demonstration week |
| `src/*.test.ts` | The desk's limits, each tool, the approval gates on a real harness, the package and the scenarios |
| `skills/` | `dispatching-crews`, `changing-the-schedule`, `handling-call-outs`, and the generated `company-handbook` |
