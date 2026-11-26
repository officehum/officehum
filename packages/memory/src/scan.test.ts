/**
 * The pattern scan, one case per pattern with its near misses. Every number here is a published
 * test value (Stripe's test card and routing number, the IBAN registry's example), and every key is
 * built by concatenation from obviously fake parts, so secret scanners do not flag this file.
 */

import { describe, expect, it } from "vitest";
import { scanText } from "./scan.js";

const TEST_CARD = "4242 4242 4242 4242";
const TEST_IBAN = "GB82 WEST 1234 5698 7654 32";
const TEST_ROUTING = "110000000";

describe("scanText: payment details", () => {
  it("finds an IBAN with a valid check, spaced or not, and passes one that fails mod 97", () => {
    expect(scanText(`Pay to ${TEST_IBAN}.`).paymentDetails).toBe("an IBAN");
    expect(scanText(`Pay to ${TEST_IBAN.replaceAll(" ", "")}.`).paymentDetails).toBe("an IBAN");
    expect(scanText("Pay to GB82 WEST 1234 5698 7654 33.").paymentDetails).toBeUndefined();
  });

  it("finds an ABA routing number by its checksum, and passes a 9-digit number that fails it", () => {
    expect(scanText(`Routing ${TEST_ROUTING}, thanks.`).paymentDetails).toBe(
      "an ABA routing number",
    );
    expect(scanText("Ticket 110000001 is closed.").paymentDetails).toBeUndefined();
  });

  it("finds a card or account number by Luhn, and passes a 16-digit order number that fails it", () => {
    expect(scanText(`Card ${TEST_CARD} on file.`).paymentDetails).toBe("a card or account number");
    expect(scanText("Card 4242-4242-4242-4242 on file.").paymentDetails).toBe(
      "a card or account number",
    );
    expect(scanText("Order 4242 4242 4242 4241 shipped.").paymentDetails).toBeUndefined();
    expect(scanText("Order 1234567812345678 shipped.").paymentDetails).toBeUndefined();
  });

  it("finds wording about changed bank or wire details, and passes ordinary bank talk", () => {
    for (const text of [
      "Acme says their bank details have changed.",
      "Please use our new bank details from now on.",
      "Smith & Co updated their wire instructions.",
      "Our banking information changed last week.",
    ]) {
      expect(scanText(text).paymentDetails, text).toBe(
        "wording about changed bank or wire details",
      );
    }
    for (const text of [
      "Acme pays by bank transfer within 30 days.",
      "The bank holiday moves the delivery to Tuesday.",
      "Jane changed the delivery address.",
    ]) {
      expect(scanText(text).paymentDetails, text).toBeUndefined();
    }
  });

  it("finds nothing in ordinary text with short numbers and dates", () => {
    expect(scanText("Acme's AP contact is Jane; call 555 0100 before 2026-12-01.")).toEqual({});
  });
});

describe("scanText: secrets", () => {
  it("finds a private key block", () => {
    const block = [
      "-----BEGIN ",
      "RSA PRIVATE",
      " KEY-----\nAAAA\n-----END ",
      "RSA PRIVATE KEY-----",
    ];
    expect(scanText(block.join("")).secret).toBe("a private key");
  });

  it("finds API keys by their known shapes", () => {
    const fake = "x".repeat(24);
    for (const key of [
      `sk_${"live"}_${fake}`,
      `sk${"-"}${"ant-"}${fake}`,
      `AKIA${"FAKE".repeat(4)}`,
      `ghp_${fake}${"y".repeat(12)}`,
      `xox${"b"}-${"0".repeat(12)}-fake`,
    ]) {
      expect(scanText(`The key is ${key} for now.`).secret, key).toBe("an API key");
    }
  });

  it("finds a labelled password, key or token", () => {
    expect(scanText("The portal password: hunter-fake-22").secret).toBe(
      "a password or labelled secret",
    );
    expect(scanText("api_key = not-a-real-value").secret).toBe("a password or labelled secret");
  });

  it("passes text that only talks about keys and passwords", () => {
    for (const text of [
      "Jane handles password resets for the portal.",
      "Keys to the warehouse are with the night guard.",
      "Use the sk_live keys only in production.",
    ]) {
      expect(scanText(text).secret, text).toBeUndefined();
    }
  });
});
