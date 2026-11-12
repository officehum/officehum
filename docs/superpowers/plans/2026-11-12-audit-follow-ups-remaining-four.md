# Audit follow-ups: the four that need no decision (RASF-3572)

Four items left on RASF-3572 after PRs 129 to 131. Each is independent.

| Item | What is built |
| --- | --- |
| A client that gives up signing in does not tell an approvals-only caller | `WebSocketTransport` calls every `onLost` with the `unauthorized` error before it stops. |
| Board `assign` has no authorisation check | `Board.assign` refuses anyone but the ticket's assignee, whoever opened it, or a person (`unauthorized`). The relay hands an unroutable ticket to a person in the name of whoever opened it. |
| Completion evidence is true before any work, or can never be true | Running evidence is RASF-3230 and stays there. Here: `checkAgent` refuses a `done` tool entry that passes an argument its tool does not take; the seven catalog entries that could not tell done from not done are removed, leaving `{ "person": true }`. |
| Red-team hand-off cases are not in the eval runner | Decision: they stay in `redteam-handoff.test.ts`, over the real relay. The scenario runner drives one role on one ticket with stubbed tools, and making it multi-role for two cases would rebuild it. The gap that mattered, no guard-off control, is closed with an RT-L1 control case. |

## Left out

- A manifest rule that tool evidence must take an argument from the ticket. The Role Factory's
  interview writes tool evidence with no arguments, so the rule needs an interview question first;
  proposed on RASF-3231.
- The catalog's remaining tool evidence (`list_invoices` by customer, `list_jobs` by client,
  `search_price_book`, `list_leads`) names the ticket's subject but can still be true before the
  work when older records exist. It needs defined ticket payloads; noted on RASF-3230.
