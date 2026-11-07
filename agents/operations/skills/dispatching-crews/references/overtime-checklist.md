# Before asking for overtime

- The job exists on the schedule, with its date and crew-hours from `list_jobs`.
- `assign_crew` was refused for this crew and this job because of the weekly hours cap, and the
  refusal stated the overtime hours.
- No other crew has room that day without time off (checked with `list_crews`).
- The request names the crew, the job and exactly the hours the refusal stated.
- The reply says the overtime is with the Operations Manager, by name, until the approval answers.

# After the answer

- Approved: the receipt shows the overtime and the assignment. Tell the client or crew the crew is
  booked, with the date.
- Declined: the job keeps no crew. Say it was declined, plainly, and what happens next. Do not ask
  again the same day for the same job.
