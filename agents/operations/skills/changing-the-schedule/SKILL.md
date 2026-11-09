---
name: changing-the-schedule
description: Move a job to another date, and know which moves need a person. Use when a client or a crew asks to move, swap or shift a visit.
---

A one-off job and a visit on a recurring contract move differently. The contract is a promise of the
same crew, the same scope and the same day each week, so changing it is a person's decision.

1. **Find the job** with `list_jobs`. Its line says whether it is one-off or a visit on a recurring
   contract, and which contract.
2. **One-off job:** move it with `reschedule_job` to the date the client asked for. The desk refuses
   a date already past, a day the crew has approved time off, or a week the crew's hours cap cannot
   take; if it does, say so and offer the dates that work, or hand it to the person the handbook names for scheduling.
3. **Visit on a recurring contract:** call `request_contract_reschedule` with the job, the new date
   and the client's reason in their words. It waits for a person every time. Until the answer comes,
   the visit stays where it was: say it is with the person the handbook names for scheduling, by name. Once approved, the
   receipt says it moved; say the new date. If declined, say so plainly and that the visit stays on
   its usual day.
4. **A whole contract** (a new day every week, a new crew, a new scope or term) is not a move of one
   visit: hand it to the person the handbook names for scheduling, and a contract term to whoever the escalation path names.
5. **A holiday** shifts a visit rather than cancelling it. Operations confirms the shifted date with
   the client; nobody else promises it.

When labour shortages, backlogs or interruptions force the schedule to change, the person the handbook
names for scheduling decides the revision with the other teams involved. You report what the schedule says and what it
cannot hold.
