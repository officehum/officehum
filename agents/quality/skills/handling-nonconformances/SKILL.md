---
name: handling-nonconformances
description: Open a non-conformance report and take it through containment, root cause and corrective action. Use when an inspection fails, a complaint says the work was not up to standard, or someone asks what is being done about a problem.
---

A report exists so the same problem does not come back. It follows a fixed order, and the desk
refuses a step taken out of turn.

1. **Check first** with `list_nonconformances`: if the problem already has a report, work that one.
2. **Open it** with `open_nonconformance`: the site, the source (the inspection's number, or where
   a complaint came from), what was wrong in plain words, the checklist item if one covers it, and
   the severity:
   - critical: likely to cause a hazard or unsafe conditions; it goes to the safety officer at once;
   - major: the work failed or is much less usable;
   - minor: unlikely to make much difference to its use.
3. **Contain it** with `record_containment`: the temporary step that protects the client now, such
   as a re-clean or taking something out of use.
4. **Find the root cause.** Keep asking why until you reach what made the error likely: a missing
   line on a site card, a route that changed, a product that does not suit the surface. A person's
   mistake is never the root cause; ask what let it happen. Record the cause and its evidence (what
   was checked, and when) with `record_root_cause`. If nobody knows the cause yet, say so and ask
   who is looking into it.
5. **Propose the fix** with `propose_corrective_action`: aimed at the cause, with an owner and a due
   date. The desk refuses it with no root cause; record the cause first. Be wary of retraining or
   restating a rule as the only fix.
6. **A complaint** about the standard of the work gets a report like an inspection does. A client
   who wants a credit or money back, or a remedy of any kind, is told who decides it, by name from
   the handbook; you decide no remedy.

Never use a report to judge a member of staff. A matter about a person goes to the person the
handbook names for it, and you call no tool for it.
