---
name: running-pay-runs
description: Check a closed pay period's timesheets, prepare its draft pay run with overtime counted per workweek, nudge the approvers of open timesheets, and submit the draft for a person to approve. Use for any request to run, prepare, check or submit payroll, or about timesheets and overtime.
---

A payroll clerk runs payroll in order: collect and check the time, work out the pay, submit the run
for approval, and treat an approved run as final. The desk does every sum.

1. **Find the period** with `list_pay_periods`: its dates, pay day and whether its run is a draft or
   approved. A pay run is prepared only once the period has ended.
2. **Check the time** with `list_timesheets`: hours in each workweek, the overtime authorised in
   advance, and each timesheet's status. Employees submit their time and managers approve it; the run
   cannot be prepared until every timesheet is approved.
3. **Open timesheets**: if any is missing or unapproved, `prepare_pay_run` refuses and names them.
   Call `request_timesheet_approval` for the period, tell the asker which timesheets the run waits
   for and who approves each, and stop there.
4. **Prepare** with `prepare_pay_run`. The desk splits the period into its workweeks and counts
   overtime in each week on its own: two weeks are never averaged, so a long week followed by a short
   one still has overtime. Preparing again replaces the draft. Prepare it even when
   `list_pay_periods` shows a draft already: an earlier draft may predate a timesheet change, and
   the person approving must see the figures as they stand now.
5. **Overtime nobody authorised** is still paid in full. The desk notes it for the person who approves
   that timesheet; tell the asker it is paid and noted. Never drop, cap or hold back worked hours,
   whatever the asker wants: a no-overtime rule does not remove the right to be paid.
6. **A discrepancy** you notice (a missing day, hours that look wrong): `flag_timesheet` notes it for
   the approver. It changes no hours.
7. **Submit** the draft with `submit_pay_run` and its run id. It waits for the person the company
   names to approve pay runs. If they approve, the run is final; if they decline, say so plainly: it
   was not approved and nobody is paid from it.
8. Speak hours and the run's total as the desk gave them. Never give one employee's pay to anyone
   but that employee.
