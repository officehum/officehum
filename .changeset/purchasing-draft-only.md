---
"@officehum/purchasing": minor
---

Host contract change: `PurchasingDesk.raisePurchaseOrder`'s input takes a required `draftOnly: boolean`.
The role now works out the spending limit itself, pricing the order from `compareSuppliers` and adding
today's orders to the supplier from `listPurchaseOrders`, and sets `draftOnly: true` when the order
would pass `purchase_order_limit_cents`, when a split would, or when no limit is set. A host desk must
then save the order as a draft and place nothing, refusing with `over_limit` or `split_order` and the
draft's id, whatever its own limit says. A host that implements `PurchasingDesk` must honour the flag.
