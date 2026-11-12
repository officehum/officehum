# Completion evidence on the board (RASF-3230)

## Goal

A ticket is done only when the evidence its type declares (`accepts[].done` in `officehum.json`)
checks out. The host runs the checks; the model cannot run or skip them.

## What changes

1. **SDK** (`packages/sdk/src/evidence.ts`): `resolveEvidenceArgs` substitutes `{ticket.id}` and
   `{ticket.data.<path>}` into an evidence entry's arguments and reports every placeholder the
   ticket cannot fill. `agent_reply` gains an optional `files` argument (name → file id) for `file`
   evidence.
2. **Board** (`packages/office/src/board/index.ts`, migration 10):
   - a new status, `awaiting_confirmation`, between an agent's reply and a person's answer;
   - `completable` (the refusals `complete` would give, changing nothing), `evidenceFailed` (one
     `evidence_failed` event per failed attempt; the third blocks the ticket and hands it to a
     person), `awaitConfirmation` (moves the ticket and files the Inbox request in one commit);
   - `complete` records the evidence on the `completed` event;
   - deciding the confirmation request in the Inbox completes the ticket, or returns it to the agent,
     in the same commit as the decision.
3. **Checker** (`packages/office/src/board/evidence.ts`): `completeWithEvidence` runs every declared
   check and makes exactly one of those board moves. `engine` runs the role's engine; `tool` runs
   the role's safe tool as a nested call of `agent_reply`, so it goes through the role's extension
   and its hooks; `file` reads the office's file store; `person` asks the Inbox. A check the office
   has no means to run fails closed.
4. **Office extension**: `agent_reply` calls the checker instead of `board.complete`. The runtime
   passes each role's engine.
5. **Relay**: a person's refusal to confirm is delivered to the agent that holds the ticket, so the
   work does not strand. The agent's own failed reply is not echoed back.
6. **CLI board**: tickets awaiting confirmation appear in the `waiting` column, marked.

## Decisions

- The Inbox item is an approvals row for `agent_reply` with the approval id `ticket.completion`: a
  person confirming a ticket is approving that exact reply. No second inbox.
- The person asked is the first person on the board, the relay's own fallback.
- A person's refusal counts as a failed attempt, the same as a failed check.
- A ticket type with no `done` completes as before; its `completed` event carries a warning.
- The workflow engine (RASF-3136) does not exist yet, so there is no step to hold back. It will key
  on `done`, which now means the evidence passed.

## Tests

Board transitions and the migration; the checker with a stub engine, a fake tool runner and a local
file store (fail then pass, missing record, person confirmation, three failures); `agent_reply`
end to end in a real harness with a nested evidence tool; the relay's delivery of a refusal.
