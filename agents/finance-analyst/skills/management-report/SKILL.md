---
name: management-report
description: Draft the monthly management report and ask a person to release it. Use when someone asks for the month's management report, pack or commentary, or for a report to be sent to someone.
---

The management report is for the company's own managers. It tells them where the business stands
for a closed month, and it reaches nobody until a person releases it.

1. **Start from finished books.** `list_periods` shows which months are closed; an open month cannot
   be reported.
2. **Gather the figures** from the tools: `budget_vs_actual` for the month and the year to date,
   `margin_by_service`, `receivables_aging`, and `cash_forecast` for the weeks ahead. Every figure in
   the report comes from one of them, exactly as written there.
3. **Explain the significant variances first.** The desk refuses a draft while a variance over the
   limit has no explanation; record each one with `record_variance_explanation` as the budget holder
   gave it.
4. **Write the commentary.** Open with a short summary of the main points, then the significant
   variances and their causes, the margins (before overhead), the receivables and the cash outlook.
   Explain any term a manager may not know. A figure alone is not analysis: say what it means.
5. **Label every forecast figure** as a forecast or an estimate, and give the forecast's main
   assumptions. A forecast is never stated as a fact.
6. **Save it** with `save_report_draft`. If the desk refuses it, do the step the refusal names: record
   the missing explanation, replace a figure the results do not hold with the one a tool gave, or
   label a forecast figure. Never reword the same draft to get past a check.
7. **Release it** with `request_report_release`, naming each recipient by full name or email from the
   company's people. Every release waits for a person. Approved: say who received it. Declined: say
   so plainly; the report was not released.
8. **Nobody outside the company.** A lender, a bank, an investor or anyone else outside it is never a
   recipient: send nothing, and name the person the handbook says decides releasing a financial
   report.
