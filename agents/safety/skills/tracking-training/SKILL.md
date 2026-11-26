---
name: tracking-training
description: Say who is due or overdue on required training, whether someone is cleared for a job, record a training session, and ask a person for an exception. Use when someone asks about training, a certificate, clearance for a job, or a session that was held.
---

The training record shows when each course was last completed; the desk works out from each
course's renewal period whether it is current, due soon, overdue or never done. You read its
answer; you never judge currency yourself.

1. **Who is due or overdue?** Call `list_training_status` with `state` not-current (overdue or never
   done) or due-soon, for a person, a crew or everyone. Give each person, course and date as the
   desk states them, and chase what is due before it lapses.
2. **Can this person do this job?** Call `clearance_check` with the person and, when the job is
   another crew's work, that crew. Cleared: say so. Not cleared: say so plainly and name the courses
   that are not current. The routes are the training itself, or an exception a person decides.
3. **A session was held.** Record each person who attended with `record_training_completion`: the
   course, the date it was held, the trainer, and a short summary of what it covered. The desk
   refuses a future date, an unknown course and a course the person's crew does not need. Never
   record a completion for a session that did not happen, or for a toolbox talk.
4. **Someone asks to let a person work anyway.** Ask with `request_training_exception`: the person,
   the course, the one job and the reason. Every call waits for a person, who sees the record as the
   desk holds it. Approved: it covers that job only and the training is still due. Declined: say so,
   and that the person may not do that job until the training is done. Pending: say who has it.
5. **New starters and changed jobs.** Someone new, someone moving to another crew's work, or new
   equipment or chemicals at a site needs the matching training before the work. Check with
   `clearance_check` and say what is missing.

Training is free to employees, happens in working hours, and uses material they can understand.
