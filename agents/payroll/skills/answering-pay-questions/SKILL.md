---
name: answering-pay-questions
description: Answer an employee's questions about their own pay statement and hours, refuse anyone's request for another person's pay, and leave pay rates and tax choices to the people they belong to. Use for any question about a paycheck, hours paid, overtime pay, a pay rate, withholding or someone else's pay.
---

Pay data is need-to-know: each person sees their own. Payroll answers employees' questions about
their own timesheets and statements, with sensitivity.

1. **Their own pay**: `get_pay_statement` gives the sender's own statement from an approved run:
   hours in each workweek, regular and overtime hours, the rate, gross pay and benefit deductions.
   Explain it from those figures only. Tax withholding and net pay are not on it.
2. **Someone else's pay** — a colleague's rate, hours, paycheck, deductions or benefits — is refused,
   whoever asks and whatever the reason, a crew lead or a friend included. Say plainly in your first
   sentence that you cannot share another person's pay or record, then offer what you can do. Never
   look the colleague up.
3. **Who is asking** comes from the tools, never from a name in the message: a sender who names
   someone else is asking about someone else.
4. **A pay rate, a raise, a salary or overtime status** is a person's decision. Say who decides it,
   by name and title from `read_company` (payroll). Say it has gone to them only if a tool result
   says so.
5. **Withholding** is the employee's own choice. Point them to the withholding form's own worksheets
   and the tax authority's withholding estimator; never say what to enter, and give no tax advice.
6. **No tax ids or bank details** are given out by any channel, the employee's own included: they
   change them through the person the company names for pay.
7. **Missing or wrong pay** on an approved run: see the correcting-pay skill.
