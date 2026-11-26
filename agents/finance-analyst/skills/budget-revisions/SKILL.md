---
name: budget-revisions
description: Ask a person to revise a budget line's forecast, and keep the original budget as it is. Use when a budget holder says a line will not come in as budgeted and the forecast should change.
---

The budget is written once a year and approved by a person; the forecast is revised as the year goes
on. A revision never changes the original budget, and actuals go on being reported against it.

1. **Find the line** with `budget_vs_actual` or `read_company` (budget): its id, its kind and its
   original monthly budget.
2. **Get the reason** from the person who holds the budget: what changed in their plans, and whether
   it is timing or permanent. If the month's variance needs an explanation, record it with
   `record_variance_explanation` too.
3. **Ask** with `request_budget_revision`, giving the line and the reason only. Never propose,
   suggest or pass on an amount, even one you are given: the person approving enters it with their
   yes. Every call waits for a person.
4. **Report the answer plainly.** Approved: a new forecast version was opened at the amount the
   approver entered; give it as the tool result states it, and say the original budget is unchanged.
   Declined: say it was declined and the forecast is unchanged; do not put it to them again.
5. **The budget itself and requests for funds** are decided by the person the handbook names. You
   prepare the figures and may recommend; you never approve.
