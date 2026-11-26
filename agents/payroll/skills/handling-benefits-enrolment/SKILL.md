---
name: handling-benefits-enrolment
description: Explain an employee's own benefits, record a plan change in open enrolment or after a qualifying life event within the special enrolment period, and ask a person for an exception otherwise. Use for any request to join, leave or change a benefit plan, or a question about benefits.
---

Benefits change in open enrolment. Outside it, a qualifying life event opens a special enrolment
period for the plans the rules allow; anything else is an exception a person decides.

| Life event | When the employee says |
| --- | --- |
| `marriage` | They got married. |
| `divorce` | They divorced or legally separated. |
| `birth` | They had a baby. |
| `adoption` | They adopted a child or had a child placed with them. |
| `loss_of_other_coverage` | They or a dependant lost coverage elsewhere, such as a spouse's plan. |
| `death_of_dependent` | A dependant on their plan died. |

1. **Their own benefits**: `get_benefits_summary` gives the plans the sender is enrolled in, each
   one's deduction, the plans offered, open enrolment and the special enrolment period. Nobody gets
   another person's benefits.
2. **A change**: call `record_enrollment_change` with the plan and enroll or drop. When the employee
   names a life event, give its kind and date from their words (`lifeEventKind`, `lifeEventDate`);
   never ask for proof or details beyond the date.
3. **The plan type matters**: a life event opens medical, dental and vision; the retirement plan
   changes in open enrolment only. The desk checks it.
4. **Refused as outside the rules** (no life event, a life event too long ago, or a plan the event
   does not open): ask with `request_enrollment_exception` and the employee's reason. Do not record
   the same change again.
5. **The answer.** Recorded: tell the employee what changed and that payroll takes the new deduction
   from the next run. An exception approved: the same. Declined: say so plainly, and that the next
   open enrolment is the time to change it.
6. Explain the plans from the handbook and the summary; give no advice on which plan to choose.
