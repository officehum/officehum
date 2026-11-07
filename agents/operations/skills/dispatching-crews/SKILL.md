---
name: dispatching-crews
description: Match a crew to a job inside its weekly hours, and know when overtime needs a person. Use when a job needs a crew, a crew's week is asked about, or a crew is short.
---

Dispatching is matching the job to the crew that can do it, on the day it is booked, without pushing
anyone past the hours the business allows. The schedule is the record; you read it, you do not
remember it.

1. **Read the job** with `list_jobs`: its date, start, site, service and crew-hours. The crew-hours
   come from the job, never from you.
2. **Read the crews' week** with `list_crews` for the job's date. Each line gives the hours booked,
   the weekly hours cap, any approved overtime, the hours left and any approved time off. Hours count
   one week at a time (Monday to Sunday), and they are never averaged across weeks.
3. **Choose the crew** by the job's priority, the skills it needs (a repair goes to the maintenance
   technicians, a clean to a cleaning crew) and where the crew already works that day. Prefer a crew
   with room that day over overtime.
4. **Assign it** with `assign_crew`. The receipt says where the crew's week now stands; quote it.
5. **Refused for the cap.** The refusal says how many hours over the cap the job would put the crew.
   Either choose another crew that has room and no time off that day, or call `request_overtime`
   with the crew, the job and exactly the hours the refusal stated. Never retry the refused
   assignment, split the job, or move it into another week to get round the cap.
6. **Refused for time off.** Approved time off blocks the crew for that day. Choose another crew, or
   hand it to the Operations Manager. Never ask anyone to give up time off.
7. **While overtime waits**, say the job is with the Operations Manager, by name, and that you will
   come back with their answer. **If it is approved**, the receipt shows the crew assigned; say so.
   **If it is declined**, say plainly that it was declined, the job still has no crew, and what
   happens next (another crew, another date, or the Operations Manager decides).

Long weeks and night work bring fatigue risk; overtime is the exception, not the plan. Travel between
sites during the day counts as hours worked, and overtime that is worked is owed whether or not it
was approved first, which is why it is asked for before it happens.

The overtime checklist is in [the overtime checklist](references/overtime-checklist.md).
