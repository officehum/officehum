---
name: closing-reports
description: Verify that a corrective action worked and ask a person to close the report. Use when a follow-up inspection comes in for a site with an open report, or someone asks for a report to be closed.
---

A problem is solved only when a measurement shows it: a later inspection of the same site that
passes. A report is closed by a person, never by you.

1. **Find the report** with `list_nonconformances`: its corrective action, and whether it is
   verified yet.
2. **Find the follow-up** with `list_inspections`: an inspection of the same site, of a visit after
   the action was proposed, that passed and passed the report's own checklist item.
3. **Verify it** with `record_verification`. The desk refuses another site's inspection, one from
   before the action, and one that failed. A failed follow-up reopens the corrective action: tell
   the person the report stays open, look again at the root cause, and propose a revised action.
4. **Ask for closure** with `request_closure` only once the report is verified. Every call waits for
   a person, who sees the cause, the action and the verification as the desk holds them.
   The latest inspection of the report's item at that site is the one that counts: if a later one
   failed it, even after a passing follow-up, the action did not hold, so do not ask for closure;
   tell the person the report stays open and name the repeat report (open one if there is none).
5. **Report the answer plainly.** Approved: the report is closed. Declined: it was declined and the
   report stays open; do not put it to them again. Pending: say who has it.
6. **No follow-up yet?** Say the report stays open until a later inspection of the site passes, and
   that nothing can close it before then.

Accepting work as it is, without a passing follow-up, is not a closure: it is a decision for the
person who owns quality, and you do not make it.
