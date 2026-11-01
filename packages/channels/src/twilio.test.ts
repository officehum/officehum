import { describe, expect, it } from "vitest";
import { type E164, parseE164 } from "./adapter.js";
import { twilioSignature } from "./signature.js";
import {
  EMPTY_TWIML,
  formParams,
  TWILIO_FORM_CONTENT_TYPE,
  TWIML_CONTENT_TYPE,
  TwilioAdapter,
} from "./twilio.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const URL = "https://office.example.test/hooks/twilio";
const BUSINESS = e164("+15005550006");
const CUSTOMER = e164("+15551234567");
const SID = "SM11111111111111111111111111111111";

function e164(value: string): E164 {
  const parsed = parseE164(value);
  if (parsed === undefined) throw new Error(`fixture is not E.164: ${value}`);
  return parsed;
}

/**
 * A real Twilio message webhook body, as `application/x-www-form-urlencoded` carries it: `+` in a phone
 * number is percent-escaped, spaces are `+`, and Twilio sends more fields than this build reads
 * (`AccountSid`, `NumSegments`, …). The extra fields matter: they are part of what the signature covers
 * even though they are not parsed.
 */
function twilioBody(overrides: Readonly<Record<string, string>> = {}): string {
  return new URLSearchParams({
    AccountSid: "AC11111111111111111111111111111111",
    ApiVersion: "2010-04-01",
    Body: "The sink is leaking again",
    From: CUSTOMER,
    MessageSid: SID,
    NumSegments: "1",
    SmsSid: SID,
    SmsStatus: "received",
    To: BUSINESS,
    ...overrides,
  }).toString();
}

function adapter(): TwilioAdapter {
  return new TwilioAdapter({
    authToken: TOKEN,
    businessNumber: BUSINESS,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
}

function accepted() {
  const body = twilioBody();
  const params = formParams(body);
  const result = adapter().accept({
    url: URL,
    body,
    signature: twilioSignature(TOKEN, URL, params),
  });
  return result;
}

describe("TwilioAdapter", () => {
  it("parses a real Twilio form body into the message shape", () => {
    const result = accepted();
    expect(result).toEqual({
      accepted: true,
      message: {
        from: CUSTOMER,
        to: BUSINESS,
        body: "The sink is leaking again",
        messageSid: SID,
        receivedAt: "2030-01-01T00:00:00.000Z",
      },
    });
  });

  it("is the channel's inbound adapter and declares no way to send", () => {
    const inbound = adapter();
    expect(inbound.channel).toBe("sms");
    // The expect-error IS the test: the next line must not typecheck. If a `send` member is ever added
    // to the adapter, this line starts compiling and `tsc -p tsconfig.test.json` — which runs as part of
    // `npm run typecheck` — fails on the now-unused directive. A comment asking reviewers to keep the
    // channel inbound-only would be a note; this is a check.
    // @ts-expect-error -- a channel with no send member cannot be asked to send
    const send = inbound.send;
    // The same fact at runtime, for anyone reading the built object rather than the type.
    expect(send).toBeUndefined();
    expect(Object.hasOwn(inbound, "send")).toBe(false);
  });

  it("refuses a body whose signature does not match, and says why", () => {
    const body = twilioBody();
    const result = adapter().accept({ url: URL, body, signature: "not-a-signature" });
    expect(result).toEqual({ accepted: false, reason: "signature" });
  });

  it("refuses a missing signature header", () => {
    const result = adapter().accept({ url: URL, body: twilioBody(), signature: undefined });
    expect(result).toEqual({ accepted: false, reason: "signature" });
  });

  it("refuses a verified message addressed to a number that is not ours", () => {
    const body = twilioBody({ To: "+15005550100" });
    const result = adapter().accept({
      url: URL,
      body,
      signature: twilioSignature(TOKEN, URL, formParams(body)),
    });
    expect(result).toEqual({ accepted: false, reason: "wrong_number" });
  });

  it("refuses fields that are not E.164 after a valid signature", () => {
    const overrides: ReadonlyArray<Readonly<Record<string, string>>> = [
      { From: "555-123-4567" },
      { To: "1 (500) 555-0006" },
      { MessageSid: "" },
    ];
    for (const field of overrides) {
      const body = twilioBody(field);
      const result = adapter().accept({
        url: URL,
        body,
        signature: twilioSignature(TOKEN, URL, formParams(body)),
      });
      expect(result).toEqual({ accepted: false, reason: "malformed" });
    }
  });

  it("refuses to be built with a placeholder auth token", () => {
    for (const token of ["", "test", "changeme", "0123456789abcdef0123456789abcde"]) {
      expect(() => new TwilioAdapter({ authToken: token, businessNumber: BUSINESS })).toThrow(
        /32 hexadecimal/,
      );
    }
  });

  it("parses a body into a record with no prototype, so a parameter cannot reach Object", () => {
    expect(Object.keys(formParams(""))).toEqual([]);
    const params = formParams("__proto__=polluted&From=%2B15551234567");
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.keys(params).sort()).toEqual(["From", "__proto__"]);
    expect(params.From).toBe("+15551234567");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("empty TwiML", () => {
  it("is the documented empty response, byte for byte", () => {
    expect(EMPTY_TWIML).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it("carries no message, so Twilio has nothing to send", () => {
    expect(EMPTY_TWIML).not.toContain("<Message");
    expect(TWIML_CONTENT_TYPE).toBe("text/xml");
    expect(TWILIO_FORM_CONTENT_TYPE).toBe("application/x-www-form-urlencoded");
  });
});
