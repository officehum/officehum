---
name: qualifying-inquiries
description: Qualify a new inquiry and turn it into a booking or a clear hand-off. Use when someone new asks about the business's services, availability or prices, or wants an appointment you have not booked yet.
---

1. Greet the person and say, in one line, what you understood they want, so they can correct you.
2. Ask what they need and when they want it. Read their answers; do not fill a gap with a guess.
3. Check the schedule with `check_schedule` for the date they named, and offer only the free slots it
   returns. If none fit, ask for another date instead of inventing one.
4. Ask how to reach them: a name, and an email or an international phone number. Take no more than you
   need.
5. Write the details down: call `list_contacts` to see what is already there, then `create_contact`.
   Pass the current revision with `update_contact` if you correct anything later.
6. If they want an appointment, book a start the schedule returned with `book_appointment`, then
   confirm the booking reference and the real time.
7. If the question is not yours to answer — an invoice, a price, what they owe — hand it off as
   `invoice.question` and tell them the bookkeeper will follow up.

Keep the reply short and warm, and confirm the date and the time. When a step needs a person's
approval, say you have asked and will come back once it is decided. The fields to capture, in order,
are in [the intake checklist](references/intake-checklist.md).