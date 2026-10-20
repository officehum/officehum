/**
 * The opt-in test against a real QuickBooks sandbox company. It is skipped unless `QBO_SANDBOX=1`,
 * so CI never touches the network or holds a credential. Run it by hand, with a sandbox company's
 * realm id and a fresh access token in the environment:
 *
 *   QBO_SANDBOX=1 QBO_REALM_ID=<sandbox company id> QBO_ACCESS_TOKEN=<token> \
 *     npx vitest run packages/quickbooks/src/sandbox.test.ts
 *
 * This checkout has no sandbox credentials, so this test has NOT been run here; it is reported as
 * skipped, never as a pass. Its assertions are written to hold whether or not the sandbox applies
 * sales tax: it checks the round trip and the idempotent retry, not an exact company tax figure.
 */

import { describe, expect, it } from "vitest";
import { quickbooksClient } from "./index.js";

const enabled = process.env.QBO_SANDBOX === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Set ${name} in the environment to run the QuickBooks sandbox test.`);
  }
  return value;
}

describe("QuickBooks Online sandbox (opt-in)", () => {
  it.skipIf(!enabled)(
    "creates an invoice, reads it back, and a retried write does not duplicate",
    async () => {
      const client = quickbooksClient({
        realmId: required("QBO_REALM_ID"),
        getAccessToken: async () => required("QBO_ACCESS_TOKEN"),
        environment: "sandbox",
      });

      const customers = await client.findCustomers("");
      const customer = customers[0];
      if (customer === undefined) {
        throw new Error(
          "The sandbox company has no customers; add one in QuickBooks, then re-run.",
        );
      }

      const requestId = `officehum-sandbox-${Date.now()}`;
      const draft = {
        customerId: customer.id,
        lines: [
          {
            description: "Office Hum sandbox check",
            quantity: 1,
            unitPrice: { cents: 1234, currency: "USD" },
          },
        ],
      };

      const created = await client.createInvoice(draft, { requestId });
      expect(created.id.length).toBeGreaterThan(0);
      expect(created.customerId).toBe(customer.id);
      expect(Number.isSafeInteger(created.total.cents)).toBe(true);
      expect(created.total.cents).toBeGreaterThanOrEqual(1234);

      // The same requestId must replay the first invoice, not create a second one.
      const retried = await client.createInvoice(draft, { requestId });
      expect(retried.id).toBe(created.id);

      const readBack = await client.getInvoice(created.id);
      expect(readBack.id).toBe(created.id);
      expect(readBack.total).toEqual(created.total);
      expect(readBack.customerId).toBe(customer.id);
    },
  );
});
