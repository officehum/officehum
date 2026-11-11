# Remote approvals over the gateway (RASF-3108)

**Goal:** when an agent calls a gated tool in the runtime, the right people are asked through the
gateway. One of them decides with their authenticated identity, and the decision is durable and
audited. Declines and timeouts mean the tool never runs.

**Spec:** the issue; `docs/design/gateway-protocol.md`; `packages/sdk/src/approvals.ts` (the role's
own `approvalGate`, which asks an `Approver` and memoises the answer in the tool task).

## How it fits

Roles already gate their tools with the SDK's `approvalGate`, which asks the `Approver` that
`loadRole` hands them and memoises the answer, so a decided call runs once and is never asked about
again. Today the runtime hands roles no approver, so every gated call is refused. This change gives
them one: the runtime's **remote approvals** store.

- **Office (`packages/office/src/runtime/approvals.ts`).** `RemoteApprovals` is one `Approver` shared
  by every role in the runtime. It is created before the roles load and bound to the office when the
  runtime opens.
  - **Asked:** it records the request durably in a Pi Durable doc (`officehum.runtime.approvals`).
    The `approvalId` is `<taskId>:<callId>:<approval id>`.
  - **Announced:** it emits `approval_requested` on the request's event stream, and sends an
    `approval` message for the gateway to route.
  - **Waits:** for a decision, its timeout, or the run being aborted.
  - **Decided:** the decision is recorded with `by` (the principal id), the time and the note. It is
    added to an append-only audit list, and `approval_decided` is emitted.
  - **After a restart:** a resumed run asks again and finds the stored request, or the stored
    decision.
  - **Timeout:** per agent (`approvalTimeoutMinutes` on the office file's role entry), 240 minutes by
    default. It declines with the note `timed out`.
  - **Rules:** the first decision wins, and later ones get `conflict`. An approver with a limit may
    decide only when the call's amount is known and within it, or gets `forbidden`.
- **SDK.** `approvalAmount(declaration, args)` is the number the declaration's numeric `when`
  condition compares, using the same rules as `conditionsHold`. It is `undefined` when there is none.
- **Protocol.** These additions are backwards compatible:
  - `approval_requested` gains optional `agent` and `expiresAt`.
  - A new command, `watch_approvals`, replies with the pending approvals the caller may decide. After
    that, the connection receives `approval` messages.
  - A new server message, `approval`, is one approval's current state.
- **Gateway.**
  - Approve rules gain optional `agents` (default: every agent).
  - The router keeps the approvals the runtime announced, with their agent.
  - **`approve`:** an unknown approval gets `not_found`. Otherwise the gateway checks the rule for the
    approval's agent, then forwards with the capped `approvalLimit`.
  - **`watch_approvals`:** the gateway registers the connection, and sends it only approvals for
    agents it may approve.
- **Client.** `client.watchApprovals(listener)` returns the pending list and calls `listener` on each
  change. It watches again after a reconnect.

## Tests

| Where | What |
| --- | --- |
| `approvals.test.ts` (office) | Ask, then approve, records `by` and the time, and the audit names the principal. A decline. A timeout. First wins and the second gets `conflict`. The limit rules. Amount: unknown for a limited approver, over the limit, and no limit. A restart keeps a pending approval. |
| Runtime end to end, via the gateway fixture | A gated fixture tool: approve, the tool runs once. Decline and timeout: never runs. A kill while waiting, then approve after the restart: the tool runs once. |
| Gateway | `approval_requested` reaches an authorised watcher only. A principal with no rule, or over their limit, gets `forbidden`. Two approvers at once: one wins, the other gets `conflict`. |
| Client | `watchApprovals` plus `approve` resumes the gated tool against the real gateway. |
