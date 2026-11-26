# @officehum/quickbooks

A portable, typed QuickBooks Online client (`quickbooksClient`) and an in-memory fake with the same
interface (`fakeQuickBooks`), for the Bookkeeper's `quickbooks` option: customers, invoices, sending
an invoice and payments. Amounts are integer cents. Writes carry a request id QuickBooks uses to
refuse a duplicate. The client does no OAuth and stores no credential: the host passes a function
that returns a fresh access token on every call. No Office Hum dependency.

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it (`npm pack -w @officehum/quickbooks`) and
install the tarball.

## Example

```ts
import { fakeQuickBooks, quickbooksClient } from "@officehum/quickbooks";

// In tests and demos: no network.
const books = fakeQuickBooks({ customers: [{ id: "c1", displayName: "Harbor Bakery", active: true }] });
await books.findCustomers("Harbor"); // [{ id: "c1", displayName: "Harbor Bakery", active: true }]

// Against QuickBooks: the company (realm) id and a token you obtain and refresh yourself.
const live = quickbooksClient({
  realmId: "4620816365",
  environment: "sandbox",
  getAccessToken: async () => process.env.QUICKBOOKS_ACCESS_TOKEN ?? "",
});
```

## Docs

- ["Run one role package"](../../docs/reference.md#run-one-role-package) in the reference: giving
  the Bookkeeper this client with `--clients`.
- [Bookkeeper](../../agents/bookkeeper/README.md), the role that uses it.
