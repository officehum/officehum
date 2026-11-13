# One source for limits: the manifest (RASF-3575)

## Goal

Every amount a business sets is a named limit in a role's `officehum.json`, changed in its overlay.
No role can state one limit and enforce another.

## What changes

1. **Purchasing** declares `purchase_order_limit_cents` (default 150000). The role reads its
   resolved limit at every call and hands it to the desk with the order, as Sales does with
   `quote_limit_cents`. `PurchasingDesk.raisePurchaseOrder` takes the limit in its options; with
   none resolved the desk holds every order for a person.
2. **The company record** loses `approvalLimits`: the JSON, the SDK type, the company script's
   check, and the generated `facts.json` in every role.
3. **The handbook** (`pricing.md`, `policies.md`) names each limit without its figure. The company
   check already refuses an amount in the prose that `company.json` does not record, so with the
   figures gone from the record it refuses a limit written back into the prose.

## Decisions

- The prose loses the figure instead of being generated from the manifests: it is the smaller
  change, and an overlay's value could never reach a file generated from defaults.
- The role states the figure itself: Purchasing in `read_company`'s purchasing section and in every
  refusal, Sales in the receipt of a quote it holds.

## Tests

An overlay that lowers Purchasing's limit holds an order the default places, and `read_company`
states the overlay's figure; an order with no limit resolved is held; a limit's amount in the prose
is refused; the manifests hold the limits and the record holds none.
