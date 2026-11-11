# Local-board communication tools (RASF-3112)

**Goal:** roles on someone's own Pi Durable harness, without Office Hum, hand work to each other with
the same `agent_dispatch`, `agent_inbox` and `agent_reply` tools the office gives them.

**Spec:** the issue; `packages/office/src/extension/index.ts` (the office tools, matched exactly);
`docs/design/agent-package.md` (portability).

## Decisions

- **AGENTS.md.** The owner approved narrowing the hard rule (2026-11-11). Delivery submits from the
  SDK, but only through the tool's own API (`api.conversation(id).submit`), never `Harness.open`,
  storage or `resume`. The PR waits for the owner's review because it changes AGENTS.md.
- **Who creates conversations.** A tool cannot create a conversation with another role's agent
  (`tx.createConversation` takes no agent; only the `Harness` does). So the user creates one
  conversation per role with their harness, and gives the local board `conversationOf(roleId)`. A
  delivered ticket is submitted there with `requestId` set to the ticket id, so delivery happens once
  per conversation, and `whenBusy: "followUp"`.
- **One contract.** The tools' names, descriptions, parameters, replay policies and answer texts live
  in `packages/sdk/src/communication.ts`. Both the office extension and the local board build from it
  (a refactor commit first, with no behaviour change).
- **Tickets** live in a session document (`officehum.local-board`) in the same harness: id, type,
  title, detail, payload, `createdBy`, assignee, status (`open`, `claimed`, `done`), result, times, and
  a caller-key index for dedupe. A dispatch commits the ticket, then submits. A dispatch that crashed
  between the two leaves the ticket undelivered; the next dispatch from any role delivers it first.
- **Wait.** `wait: true` waits for the delegate's submission to settle, then reads the ticket. If the
  ticket is done, the dispatch returns its result. If the delegate finished without replying, it
  returns `did not complete: the colleague finished its turn without replying`. A timeout returns
  `did not complete: timed out`.
- **Out of scope:** budgets, hop limits, provenance, person routes and approvals.

## Shared tests

The cases live in `packages/sdk/src/fixtures/communication-cases.ts`, which is test support and not
built. Each implementation supplies a small adapter, and both test suites run the same cases:

- the hand-off with `wait` returns the delegate's reply;
- an unknown type is refused and the accepted types are named;
- the same call retried makes one ticket;
- `agent_reply` takes an open ticket and completes it;
- `agent_reply` refuses a ticket another agent holds;
- `agent_reply` answers an unknown ticket;
- `agent_inbox` lists assigned and opened tickets with their answers, filters by status, and says
  "nothing" when there is nothing;
- `agent_inbox` changes nothing.

The office runs them at the end of `packages/office/src/extension/office.test.ts`, over its real board and relay. The local board
runs them, plus delivery and restart cases, in `packages/sdk/src/local-board.test.ts`.
