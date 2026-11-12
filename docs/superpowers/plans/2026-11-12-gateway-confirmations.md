# Ticket confirmations through the gateway (RASF-3574)

## Goal

A person signed in at the gateway can see and answer the tickets waiting for a confirmation, the
runtime can check `file` evidence, and `get_state` shows why a request is still open.

## What changes

1. **`packages/office/src/runtime/confirmations.ts`**: reads the board's waiting confirmation
   requests as protocol approvals, routes an `approve` to the board, and watches the board so a
   request asked, or an answer given at `officehum board`, is announced to the gateway. It stores
   nothing of its own.
2. **`runtime.ts`**: `watch_approvals` lists confirmations beside gated calls; `approve` goes to
   whichever owns the id; `get_state` adds each agent's unfinished tickets; a `files` option reaches
   the office extension.
3. **Protocol**: `ApprovalInfo.expiresAt` becomes optional.
4. **CLI**: `officehum runtime --board` opens a file store in `files/` beside the board.

## Decisions

- **No deadline.** A gated call times out because a run waits on it. Nothing runs while a ticket
  waits, and a timeout would wake the agent to redo work nobody faulted. So `expiresAt` is optional
  in the protocol instead of confirmations getting a timer.
- **No limit check.** An approval limit caps spending; a confirmation spends nothing. Who may
  confirm is still the gateway's `approve` rule for the ticket's agent.
- **The decider is the principal.** The board records the gateway's principal id as who confirmed,
  whether or not that id is a person in the company record.
- **`get_state` lists tickets per agent**, not per request: the board does not record which request
  opened a ticket, and the agent's list answers the same question.
