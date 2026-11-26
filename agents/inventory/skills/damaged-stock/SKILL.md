---
name: damaged-stock
description: Take damaged, defective or expired stock out of use with a hold, and ask a person to write it off. Use when someone reports broken, leaking, spoiled or expired stock, or asks for a write-off.
---

Damaged stock is taken out of use first, recorded, and only then disposed of by a person's decision.

1. **Hold it.** `hold_stock` with the location, the item, how many and the reason as reported
   (damaged, defective, expired, or under investigation). Held stock stays on the record but cannot be
   issued or moved. If the report does not say how many or where, ask.
2. **Ask for the write-off** with `request_write_off` and the hold's id from the receipt. Only held
   stock can be written off: never ask to write off stock that has not been held. The desk shows the
   person the hold and its value; you never state a value of your own.
3. **When the approval comes back,** approved: the stock is off the record; declined: say plainly it
   was declined and the stock stays held, and that what happens to it is the approver's call. A
   decline names nobody: never write that the person you asked declined it.
4. **Never dispose of or return stock yourself**, and never promise a return to the supplier or a
   credit: that is the Purchasing role's.
5. **Chemicals.** A leaking or unlabelled chemical container is held like any other stock; never
   remove its label. Someone hurt, a spill that needs cleaning up, or signs of a break-in are safety
   matters: name the safety officer from the handbook.

A hold someone asks about is answered from `list_stock_levels`, which shows the held quantity.
