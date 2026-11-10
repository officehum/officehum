# Demo desk only when asked (RASF-3463)

## Problem
Every role that keeps records behind a desk (Bookkeeper's payables, Marketing, Operations, People Ops,
Purchasing, Sales, Support) builds its demonstration desk when the host passes no `desk`. A production
host that forgets to bind its real system gets fabricated demo records held in memory, and writes go
nowhere, without any sign that anything is wrong. RASF-3463 found it in Sales; the same fallback is in
all seven. Front Desk and Office Manager have no desk and are unchanged.

## Design
- **One host-set flag, `demo`.** `loadRole` (`packages/office/src/roles/load-role.ts`) gains
  `LoadRoleOptions.demo?: boolean`, passes it to the factory as `demo`, and adds `"demo"` to
  `RESERVED_ROLE_OPTIONS`, so a client file or user config can never set it.
- **Who sets it.** The eval runner (`packages/office/src/evals/pi-durable-runner.ts`) always loads with
  `demo: true`: evals run on the demonstration data by definition (approval facts readers read it).
  `officehum run` gains `--demo`; without it and without a `desk` client the role starts and its desk
  tools refuse. The run banner says which: `Desk: demonstration data (--demo)` or nothing new when a
  desk client is bound / `Desk: none bound (pass --demo, or a desk in --clients)` when neither.
- **Each desk role's factory.** `options.desk ?? (options.demo === true ? fake…(…) : undefined)`. The
  role's `now` default keys on the same condition it keys on today, but via the demo flag: demo data's
  date (`DEMO_NOW`) only when the demo desk is in use. Tools already take an optional desk and refuse
  at the point of use through `requireDesk`; its message becomes actionable and the same shape in every
  role: `No <role> desk is bound to this role, so nothing was read or written. The host passes its
  system of record as \`desk\`, or sets \`demo\` to run on the demonstration data.` A refusal is a tool
  error result the model reads, never a crash of the harness.
- **Everything else that reads the desk** (approval facts readers, Purchasing's
  `purchaseOrderReplyCheck(desk)` hook, Bookkeeper's payables) must cope with no desk: a facts reader
  throws the same refusal (the gate then asks nobody); a hook with no desk does nothing.
- **Factory option docs** say: omitted desk + no `demo` = tools refuse; `demo: true` = the
  demonstration desk.
- **No SDK change** beyond what is above; no shared abstraction for seven one-line fallbacks.

## Tests (failing first)
- `load-role.test.ts`: `demo` reaches the factory; `demo` in clients is refused as reserved.
- Per role (each role's `index.test.ts` or `tools.test.ts`): with no desk and no `demo`, one read tool
  and one write tool refuse with the bound-desk message and nothing is written; with `demo: true`, the
  role runs on the demo desk as before. Sales: `create_quote` and `log_activity` (the issue's own test).
- Eval runner test: a role's evals still pass (the runner sets `demo`).
- CLI test for `run --demo` parsing and the banner line, following the existing `--as` tests.
- Existing tests that build a role with no desk to exercise demo behaviour pass `demo: true`.

## Docs
`README.md`, each role README, the owner's manual: `officehum run agents/<role>` examples gain
`--demo`, and the factory option is described. `docs/design/agent-package.md`: `demo` joins the
reserved factory options.

## Out of scope
A real connector for any desk (RASF-3216 for CRM). Front Desk's calendar and messaging clients.
