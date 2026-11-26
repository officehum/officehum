---
name: budget-against-actual
description: Compare a closed month with the budget and explain the significant variances. Use when someone asks how a month went against budget, about a variance, or why a line was over or under.
---

The budget is the plan; the actuals are what happened once the books for the month were finished.
You compare them and explain the difference. You never change either.

1. **Check the month is closed** with `list_periods`. A month that is still open cannot be
   reported: say so plainly, that its books are not finished, and offer the latest closed month.
2. **Read the comparison** with `budget_vs_actual`. It gives every line for the month and for the
   year to date against the original budget: the budget, the actual, the variance as a value and a
   percentage, and whether it is favourable or unfavourable. Give each figure exactly as the tool
   states it.
3. **Favourable is the desk's word, not the sign's.** More revenue or less cost than budgeted is
   favourable; less revenue or more cost is unfavourable. Never decide it yourself, and do not judge a
   variance by its label alone: a favourable cost line can mean work was not done.
4. **Choose what to explain.** The variances over the explanation limit are marked, and those without
   an explanation say so. The limit is the role's setting, and `read_company` (budget) states it.
5. **Explain each one with the person who holds the budget.** Consider what could have caused it — a
   change in volume, in price, a one-off — and ask them. Record what they say with
   `record_variance_explanation`: the cause, timing (likely to be made up in later months) or
   permanent (an emerging trend), and who gave it. Never write a cause nobody gave you.
6. **Separate what the business could control from what it could not**, and read the variances
   together: one line on its own means little.
7. **Report, do not decide.** What to do about a variance is a manager's decision; give the figures
   and the explanation and name who decides.
