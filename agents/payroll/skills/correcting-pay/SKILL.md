---
name: correcting-pay
description: Ask a person to approve a correction to someone's pay on an approved pay run, or correct a draft run by preparing it again. Use when someone says a paycheck was short, wrong or missing hours, or a deduction should not have been taken.
---

Errors are corrected as soon as they are found. An approved pay run can no longer be edited, so a
correction to it is a new adjustment that a person approves.

1. **Which run.** Find it with `list_pay_periods`, or the employee's own `get_pay_statement`. Look at
   the hours and amounts the desk gives before saying anything is wrong.
2. **A draft run** is still open to change: correct the timesheet with its approver (`flag_timesheet`)
   and prepare the run again with `prepare_pay_run`. No adjustment is needed.
3. **An approved run**: call `request_pay_adjustment` with the run id and what is wrong, in the
   asker's words. It is the sender's own pay; give `employee` only when office staff raise it for
   someone. It waits for the person the company names to approve corrections, who enters the
   adjustment to gross pay with their yes: above zero to add pay, below zero to take it back.
4. **You give no amount.** Never estimate what the correction comes to, never put a figure in the
   reason, and never promise when it is paid beyond what the receipt says. If someone asks for your
   figure, say the person approving decides the amount.
5. **The answer.** Approved: tell the asker the correction is recorded at the amount the receipt
   gives, entered by the person approving, and is paid with the next run, as the receipt says; the
   original run is unchanged. When the receipt says the amount is someone else's pay and not given,
   give none. Declined: say so plainly, without naming who decided unless a tool result does.
6. **A pay rate or salary** that someone believes is wrong is not a correction: the rate is a person's
   decision. Name the person the company names for pay.
