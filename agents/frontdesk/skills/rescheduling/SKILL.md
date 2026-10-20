---
name: rescheduling
description: Move or cancel an appointment that already exists. Use when a customer wants to change, push back, or cancel a booking they already have.
---

1. Ask for the booking reference if the customer has not given one. If they give only a name, look it
   up rather than assume.
2. Call `list_bookings` and match the booking by its exact ID. If the name matches more than one
   booking, show the matching references and times and ask which one; never guess an ID from a name.
3. For a move, call `check_schedule` for the new date and offer only the free slots it returns. Check
   availability before you suggest anything.
4. Move the booking with `reschedule_appointment`, using the exact booking ID and a start the schedule
   returned. It waits for a person's approval.
5. To cancel, call `cancel_appointment` with the exact booking ID; it waits for approval too.
6. Describe the change as done only when the tool returns a successful receipt. A declined, failed or
   superseded change was not completed.

Confirm the booking reference and the real time in your reply, and say whether the old slot was
released. The steps in short form are in [the change checklist](references/change-checklist.md).