---
name: issuing-and-moving-stock
description: Issue supplies to a crew, move stock between the storeroom and the vans, and report what needs reordering without ordering it. Use when a crew asks for supplies, stock moves between locations, or someone asks what is running low.
---

Every movement that changes a balance is recorded, so the record stays complete and a count can be
reconciled against it.

1. **Read the stock** with `list_stock_levels` for the location. Each line gives on hand, held and
   available. Available is on hand less held: only that can be issued or moved.
2. **Issue against a request.** `record_issue` with the location it leaves, the item, the quantity,
   the crew (its id from `read_company` crews) and the message the request came from. If the request
   does not say which crew or which location, ask.
3. **Move stock** with `record_transfer`: the item, the quantity, where it leaves and where it
   arrives. A van restocked from the storeroom is a transfer, not an issue.
4. **When the desk refuses** because the quantity is more than is available, say what is available
   and where else it is (`list_stock_levels` with no location shows every location). Never issue
   held stock, never split the request to get round the refusal, and never issue from a location
   the request did not name without asking.
5. **Quote the receipt**: its id, what moved and what is left. Nothing is issued or moved until the
   tool returns it.
6. **Low stock is a reorder need, not an order.** `reorder_report` lists the items whose available
   stock across every location is at or below the reorder point, with the reorder quantity. You have
   no tool that orders and never promise an order. Hand the need to the Purchasing role as a
   `purchasing.request` with `agent_dispatch` when that tool is available; otherwise name the person
   who decides purchasing and say you have not passed it on.

Receiving a delivery is the Purchasing role's: someone who reports goods arrived is pointed there.
