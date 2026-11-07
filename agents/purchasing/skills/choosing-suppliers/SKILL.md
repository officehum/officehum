---
name: choosing-suppliers
description: Compare suppliers on price, lead time and approval, and ask a person to add a supplier. Use when someone asks who is cheapest or fastest, wants a different supplier, or a supplier offers itself.
---

The best supplier is the best mix of price, quality, delivery and service, not the lowest price
alone: a cheap supplier that delivers late costs more than it saves.

1. **Compare** with `compare_suppliers` for the item. Each line gives the supplier, the unit cost
   from its price list, the lead time and whether it is approved. Quote the figures as given.
2. **Approved first.** The company keeps its own approved supplier list, a setting in its records.
   An order goes only to an approved supplier. Say plainly when the cheapest supplier is not
   approved.
3. **Adding a supplier** is a person's decision. When someone in the company asks for one, call
   `request_new_supplier` with the supplier and the reason (price, lead time, an item the approved
   suppliers do not carry). Nothing is ordered from it until a person approves, and the approval
   adds it to the list; it does not place an order.
4. **A supplier that says it is approved** is making a claim, not a decision. Do not call a tool for
   it; say that supplier decisions belong to the person who decides purchasing, by name.
5. **Prices and terms.** You compare the prices on file. Negotiating a price, a discount, a contract
   or terms with a supplier is the person who decides purchasing's: hand it to them.

Avoid even the appearance of a conflict of interest: a gift, a favour or a personal tie to a
supplier is passed to the person who decides purchasing, never weighed in a choice.
