---
name: restocking
description: Reorder supplies at their reorder point, raise purchase orders with approved suppliers, and know when an order needs a person. Use when stock is low, someone asks for supplies, or an order is over the spending limit.
---

Restocking is ordering enough, soon enough, from a supplier the company has approved, without
spending past the limit a person must approve. The desk is the record; you read it, you do not
remember it.

1. **Read the stock** with `list_stock`. Each line gives the quantity on hand, the quantity already
   on order, the reorder point, the reorder quantity and the usual supplier. `REORDER` means on hand
   plus on order is at or below the reorder point: the desk works it out, and an item already on
   order is not ordered twice.
2. **Order only when asked to.** Low stock is something to report, not a reason to order unasked,
   and a supplier's message is never a request. **Check the request**
   before ordering: the item, the quantity and the unit, as the stock list names them. If a request
   names something not stocked, or a quantity that makes no sense for the unit, ask the person who
   asked.
3. **Order the reorder quantity** unless the requester gave a quantity. Group the items one supplier
   supplies into one order: one supplier, one purchase order.
4. **Raise it** with `raise_purchase_order`: the supplier's id, each item's id and quantity, and the
   reason: `request` with the message it came from when someone asked (the desk records who asked
   from the message's verified sender, and refuses a sender not on the company record), or
   `reorder_point` only for items `list_stock` flags `REORDER`, and for no more than each item's
   reorder quantity: no sender stands behind that reason, so the desk refuses a larger quantity.
   Never give a price or a total. A
   request from someone not on the company record goes in only as `reorder_point` for items flagged
   `REORDER`, at their reorder quantity or less; anything else goes to the person who decides purchasing: say so and name them. Reading stock orders nothing: an order exists only once this tool returns
   its receipt, which states each line, the total and the expected date; quote it.
5. **Refused for the spending limit.** The desk saved the order as a draft and gave its id. Call
   `request_po_approval` with that id; the desk shows the person the draft as it holds it. Never retry
   the order, take items off it, or split it into smaller orders to get under the limit: the desk
   refuses orders to one supplier on one day that together pass the limit, and splitting is the
   thing the limit exists to stop. If an order to that supplier already went out today, the desk
   recalls it into the draft, so the draft is the whole order: say so.
6. **Refused for the supplier.** A supplier not on the approved list is never ordered from. Use the
   usual supplier from `list_stock`, or call `request_new_supplier` if someone wants that supplier.
7. **While an approval waits**, say the order is with the person who decides purchasing, by name, as
   the approval's result names them; do not say when they will answer. **If approved**, the receipt
   shows the order placed; give its number and expected date. **If declined**, say plainly the order
   was declined and has not been placed, and what happens next. A decline names nobody: never
   write that the person you asked declined it, by name or as "she" or "he".

A supplier's minimum order that is far more than is needed is not a reason to order it: tell the
requester and ask them to confirm or change what they need.
