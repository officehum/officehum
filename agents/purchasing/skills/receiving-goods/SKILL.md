---
name: receiving-goods
description: Record deliveries against purchase orders from a named person's report, answer where an order is, and hand shortages, damage and claims to a person. Use when goods arrive, someone asks about an order, or a delivery is short or wrong.
---

A receipt is the record that ordered goods arrived. It is what lets the supplier's bill be matched
to the order later, so it records what a person saw, not what was expected.

1. **Find the order** with `list_purchase_orders`, by its number or the supplier. Each line shows what
   was ordered and what has been received; the order shows when it was placed and is expected.
2. **Record only a named report.** `record_receipt` needs who reported the delivery, the message the
   report came from, the order number, and each item and quantity that arrived. Add the packing slip
   reference when it is given. If the report does not say who or how many, ask; never fill it in.
3. **Short delivery.** Record what arrived. The receipt says what is still to come; tell the
   requester, and follow it up with the expected date.
4. **More than was ordered.** The desk refuses it. Record up to what was ordered and pass the extra to
   the person who decides purchasing.
5. **Damaged, wrong or defective goods.** Record only what was accepted. A claim, a return or a credit
   from the supplier is the person who decides purchasing's: hand it to them with what was reported.
6. **Late orders.** An order past its expected date with nothing received is followed up with the
   supplier by the person who decides purchasing; say so, with the order number and date.

Recording a receipt pays nothing and approves no invoice: payment belongs to Finance and Billing.
