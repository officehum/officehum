import { describe, expect, it } from "vitest";
import { twilioSignature, verifyTwilioSignature } from "./signature.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const URL = "https://office.example.test/hooks/twilio";

/**
 * A body of the shape Twilio posts, in the order Twilio's console examples show. `Body` carries spaces
 * so the decode path is exercised: the signature is over the decoded values, not the percent-escaped
 * ones.
 */
const PARAMS: Readonly<Record<string, string>> = {
  From: "+15551234567",
  To: "+15005550006",
  Body: "Stop the line please",
  MessageSid: "SM11111111111111111111111111111111",
};

/**
 * The digest for this exact fixture, computed independently with Python's `hmac` over
 * `URL + "Body" + …` sorted by key. It pins the scheme rather than the implementation: if the sort, the
 * order of URL and parameters, or SHA-1 were ever changed, this literal stops matching.
 */
const FIXTURE_SIGNATURE = "XXskRZs9GoVMOB6FRg0JP8oVxMw=";

describe("Twilio signature", () => {
  it("computes Twilio's documented scheme over the URL and the sorted parameters", () => {
    expect(twilioSignature(TOKEN, URL, PARAMS)).toBe(FIXTURE_SIGNATURE);
  });

  it("accepts the signature a real webhook carries", () => {
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, FIXTURE_SIGNATURE)).toBe(true);
  });

  it("refuses a signature with one character changed", () => {
    const flipped = `${FIXTURE_SIGNATURE.slice(0, 4)}x${FIXTURE_SIGNATURE.slice(5)}`;
    expect(flipped).not.toBe(FIXTURE_SIGNATURE);
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, flipped)).toBe(false);
  });

  it("accepts the same parameters in a different order, because the scheme sorts them", () => {
    const reversed = Object.fromEntries(Object.entries(PARAMS).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(PARAMS));
    expect(verifyTwilioSignature(TOKEN, URL, reversed, FIXTURE_SIGNATURE)).toBe(true);
  });

  it("refuses a body it did not sign", () => {
    const tampered = { ...PARAMS, Body: "Stop the line please " };
    expect(verifyTwilioSignature(TOKEN, URL, tampered, FIXTURE_SIGNATURE)).toBe(false);
  });

  it("refuses a different URL, because the URL is part of what was signed", () => {
    expect(verifyTwilioSignature(TOKEN, `${URL}/elsewhere`, PARAMS, FIXTURE_SIGNATURE)).toBe(false);
  });

  it("refuses a missing or empty header without throwing", () => {
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, undefined)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, "")).toBe(false);
  });

  it("refuses a header of the wrong length, which is also the length guard for timingSafeEqual", () => {
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, "short")).toBe(false);
  });
});
