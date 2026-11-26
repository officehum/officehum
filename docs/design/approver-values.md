# A value the approver supplies

Status: accepted and built, 2026-11-23. Eval scenarios can script a value, and the Finance Analyst,
Payroll and Support roles use it.

Read the "Approvals" parts of [agent-package.md](agent-package.md) first. There is one approval path, the role
gate with remote approvers, and this design extends it. It adds no second path.

## The problem

A decision today is yes or no. Three roles need the person who says yes to also say how much, and
each works around the gap:

| Role | Tool | Today |
| --- | --- | --- |
| Finance Analyst | `request_budget_revision` | an approved revision is recorded with a null amount, "to be entered in the finance system" |
| Payroll | `request_pay_adjustment` | the approver is shown no amount and none is recorded |
| Support | `offer_credit` | the amount is fixed by the desk from an invoice line; the approver can only take it or leave it |

The rule this must keep: the model never supplies the figure. A budget, a pay correction or a
credit is a person's number.

## Decision

**An approval may declare one value it asks the approver for. An approval that declares a value is
only granted by a decision that carries a valid one. The value reaches the tool through the gate,
exactly once, and is recorded with who entered it.**

### Declaring it

An approval entry in `officehum.json` gains an optional `value`:

```json
{
  "id": "any_credit",
  "tool": "offer_credit",
  "description": "…",
  "amount": { "fact": "proposedCents" },
  "value": { "name": "creditCents", "label": "Credit to give", "min": 1, "maxFact": "lineCents" }
}
```

| Field | Meaning |
| --- | --- |
| `name` | what the tool calls it; a camelCase identifier ending in `Cents` |
| `label` | what the person is asked for, at most 80 characters |
| `min`, `max` | whole cents, optional; `min` defaults to 0 |
| `minFact`, `maxFact` | the name of a facts field holding a bound in whole cents, read from the role's own records when the person is asked |

One kind only: money in whole cents. Every case in hand is an amount, and one kind keeps the rule
checkable. Other kinds are a later issue when a role needs one.

`checkManifest` reports, each with its path: a `name` that is not an identifier ending in `Cents`;
`min` above `max`; a fixed bound and a fact bound given for the same side; a `value` on an approval
whose tool is `replay: "safe"`. `checkAgent` reports a `minFact` or `maxFact` that the approval's
facts reader does not declare, as it already does for `amount.fact`.

### What the person is shown

`amount`, where declared, stays what it is: the figure read from the role's records, and now also the
proposed value the person sees first. The request carries a `valueRequest` with the label and the
resolved bounds (fact bounds are read when the request is made and pinned to it, like the
arguments). A request whose bounds cannot be resolved, or resolve to `min` above `max`, is refused
before anyone is asked, as a facts reader's refusal is today.

### Deciding

`ApprovalDecision` gains `value?: number`. The gate accepts an approval as granted only when:

- the approval declares no value and the decision carries none; or
- it declares one and the decision carries a whole number inside the pinned bounds.

Anything else is not an approval. A local approver that answers yes without the value, or with one
out of bounds, gets the gate's refusal and the tool does not run; the remote path refuses the
`approve` command with `invalid` and the request stays pending, so the person can answer again. A
decline never carries a value.

The model is never told the bounds or the entered value: `approvalValueProblem` returns a
structured problem, the approver's message (`valueProblemForApprover`) names the bounds, and the
gate's block (`valueProblemForModel`) says only that the approval was not completed, that nothing was
done, and that the model must not retry or state a figure, because a bound can be another person's
pay.

**The approver's limit applies to what they enter.** For an approval that declares a value, the
figure compared with `approvalLimit` is the entered value, not `amount`: a person with a 500 dollar
limit cannot enter 900. For a value that may be negative (a pay correction downward) the limit is
compared with its absolute size. An approval that declares a value and is decided by a principal
with a limit is therefore never refused for having "no amount", which is what happens to
`pay_adjustment` and `budget_revision` today.

### Reaching the tool

The gate already hands a tool the facts the person approved by rewriting one reserved argument
(`officehumApprovedFacts`), because Pi Durable's tool API has no memo a tool can read. The value
travels the same way, in a second reserved argument, `officehumApprovedValue`:
`{ name, cents, by }`.

- Whatever the model sent under that key is stripped before anything else, as for the facts.
- The tool declares it with `approvedValueParameter()` and reads it with `approvedValue(args, name)`,
  which throws if it is absent or carries another name. A tool for an approval that declares a
  value must read it this way; `checkAgent` reports a tool whose parameters lack it.
- The value is stored in the decision memo (`officehum.approval.<call>.<approval>`), which is
  first-write-wins. A replay or a restart reads the stored decision and hands the tool the same
  value; the person is not asked twice and cannot be answered twice.

The tool uses the value for the write and records `by` beside it. It never falls back to a figure
in its other arguments.

### The record

- The runtime's stored request and `ApprovalInfo` gain `valueRequest?` (label, name, min, max) and,
  once decided, `value?` (name, cents).
- The audit record's `approved` entry gains `value`. So does the ticket event, where the asking
  conversation is bound to a ticket.
- `decide(principal, approvalId, decision, note?, value?)`.

### The protocol

The Gateway Protocol stays v1. `approve` gains an optional `value` (a whole number of cents);
`ApprovalInfo` gains the two optional fields above. A client that does not know them still lists
and declines; it cannot approve a request that asks for a value, and the error says why.

### The terminal

`terminalApprover` (`officehum run`) and `cliApprover` (Front Desk solo) ask for the value after a
yes: the label, the proposed amount if there is one, and the bounds, then an amount typed as
dollars and cents. It is parsed as text into whole cents (no floating point): digits, an optional
decimal point and at most two decimals, an optional leading minus only when `min` is negative. An
answer that does not parse or is out of bounds is asked again; an empty answer declines.

## The three roles

| Role | Approval | Value | Bounds | What the tool then does |
| --- | --- | --- | --- | --- |
| Finance Analyst | `budget_revision` | `revisedCents`, "Revised monthly budget for the line" | `min` 0 | opens the forecast version with that amount, entered by the approver; no more null amount |
| Payroll | `pay_adjustment` | `adjustmentCents`, "Adjustment to gross pay for this pay run; enter a reduction with a minus" | `minFact` and `maxFact` from the run's record (minus and plus that employee's gross for the run) | records the adjustment with its amount and who set it; refuses zero |
| Support | `any_credit` | `creditCents`, "Credit to give" | `min` 1, `maxFact` `lineCents`, the invoice line's total | issues the credit at the approved amount, recording who entered it; the desk's own figure (`proposedCents`, the approval's `amount`) is the proposal, not the result |

Each role's tool descriptions, skills and scenarios that say "the person approving enters it in the
finance system" or "the desk works out the amount" change with it, so each gets a live run before
its change merges.

## What does not change

- One approval, one tool call, the arguments pinned and shown.
- Who may decide, deadlines, escalation and the backup approver.
- The `declined` handler: Support still withdraws a declined credit in code.
- An approval that declares no value behaves exactly as today.

## Tests that define done

- The value reaches the tool exactly once across replay and across a kill between the decision and
  the write.
- A value outside the bounds, a non-integer, and an approve with no value are each refused, and the
  tool does not run; the remote request stays pending and can be answered again.
- The model cannot supply it: a call that carries `officehumApprovedValue` has it stripped, and a
  figure in any other argument or in the reason is not used.
- A fact bound is read from the role's records and pinned; changing the record after the ask does
  not move the bound.
- The limit is compared with the entered value, including a negative one.
- An old client's `approve` without a value is refused with a message that names the value.
- Each role: its unit tests, scripted evals, and a live run in both modes.
- Mutation checks on: the bounds check, the strip, the first-write-wins memo, the limit comparison.

## Out of scope

Free-form edits to other arguments. Values that are not money. More than one value per approval.
A second approver for large values.
