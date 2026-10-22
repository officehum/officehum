# Collections cadence and tones

One reminder per overdue invoice, per stage, and none until the due date has passed. The days below
are the defaults the package ships; the business's own limits — `collections_first_days`,
`collections_second_days` and `collections_final_days` in its settings — are what `send_reminder`
measures an invoice against, so an invoice can reach a stage on a different day than this table says.

| Days after the due date | Tone | What the reminder says |
| --- | --- | --- |
| 3 | `friendly` | A short nudge: the invoice number, the balance and the due date. |
| 14 | `firm` | The invoice is overdue. Ask for payment and offer to answer questions. |
| 30 | `final` | A last notice before a person takes it further. This one waits for approval. |

Then stop. A fourth reminder for the same invoice never goes out, and a stage that has been sent is
never sent a second time: the tool keeps its own durable record of every stage it sends, per invoice,
and answers with that record instead of sending again. So a run repeated later the same day, or a run
restarted after a crash, sends nothing and reports what was already sent.

A stage is not sent before its day: `send_reminder` answers with the invoice's age and the stage that
is actually due, and that answer stands. If the tool says the cadence could not be read, or the
customer has no address on file, say so and hand the invoice to a person.

Quote only what the tools returned — the invoice number, the balance and the due date. Never a figure
you worked out, and never a promise of a discount, a refund or a write-off.