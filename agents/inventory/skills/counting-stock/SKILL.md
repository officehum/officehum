---
name: counting-stock
description: Run a blind cycle count, recount before changing anything, research a difference, and settle it with a reason code or a person's approval. Use when someone reports a count, asks for a count sheet, or asks why the record and the shelf disagree.
---

A count confirms the stock exists and the record is right. The counter is accountable for an
accurate count, never for making it agree with the record. The desk is the record; you read it, you
do not remember it.

1. **Give a blind sheet.** `count_sheet` for the location lists the items to count by id, name and
   unit, with no recorded quantities. Pass it on as it is. Never tell a counter the figure on the
   record, and never record a count someone "expects" rather than counted.
2. **Record each count** with `record_count`: the location, the item, the number found and who
   counted. You never give a value: the desk compares the count with the record and values any
   difference from the catalogue's unit cost.
3. **A first count that differs changes nothing.** The desk asks for a recount. Ask for it, by
   someone other than the first counter if possible, and say the record is unchanged. A first count
   that matches closes the count as accurate.
4. **Research before the recount is recorded.** Ask what could explain the difference: an issue to a
   crew that was not recorded, stock moved to a van without a transfer, a delivery booked in wrong, a
   typing slip. Stock found in the wrong location is corrected with `record_transfer`, not counted as
   a difference.
5. **The recount's figure stands.** Record it with `record_count` and the reason code that matches
   what was found:
   `unrecorded_issue`, `unrecorded_transfer`, `receiving_error`, `data_entry_error`, `miscount` or
   `unexplained`. If nobody can explain it, `unexplained`; never pick a cause to tidy the record.
   - **Adjusted:** the desk valued it inside the limit and posted it. Quote the receipt: the count id,
     the new figure and the reason.
   - **Needs approval:** the desk left it unresolved and nothing changed. Call
     `request_adjustment_approval` with the count id and the reason code. Do not count again to get a
     smaller difference.
   - **Accurate:** the recount found the record right; nothing changed.
6. **When the approval comes back,** approved: the record now shows the counted figure; declined: say
   plainly it was declined and the record was not changed. A decline names nobody: never write that
   the person you asked declined it, by name or as "she" or "he".
7. **Suspected theft** is never a reason code and never your conclusion. Record the count as it
   stands and name the person who owns the counts.

`accuracy_report` gives the share of closed counts that matched the record, adjustments by reason
code and the counts still open; quote it as it comes.
