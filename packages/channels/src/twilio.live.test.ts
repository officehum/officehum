/**
 * The opt-in check against a real Twilio account (RASF-3162).
 *
 * It is skipped unless `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_NUMBER` are all set, so
 * CI never touches the network and never holds a credential. Run it by hand when a number has been
 * provisioned:
 *
 *   TWILIO_ACCOUNT_SID=<sid> TWILIO_AUTH_TOKEN=<token> TWILIO_NUMBER=<e164> \
 *     npx vitest run packages/channels/src/twilio.live.test.ts
 *
 * What it checks is the one fact the webhook route depends on: that the number written into the
 * office's config is a number this account actually receives on. A read, not a send — there is no
 * outbound SMS path to test, and inventing one to have something to assert would be exactly the
 * capability this ticket removes. No live run has been made from this checkout, which has no Twilio
 * account, and it is reported as skipped rather than as a pass.
 */

import { describe, expect, it } from "vitest";
import { type E164, parseE164 } from "./adapter.js";

const SID = process.env.TWILIO_ACCOUNT_SID?.trim();
const TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim();
const NUMBER = process.env.TWILIO_NUMBER?.trim();
const enabled =
  SID !== undefined && SID !== "" && TOKEN !== undefined && TOKEN !== "" && NUMBER !== undefined;

type IncomingNumber = {
  readonly phone_number?: string;
  readonly sms_url?: string;
};

describe("Twilio account (opt-in)", () => {
  it.skipIf(!enabled)("receives on the number the office config holds", async () => {
    const number = parseE164(NUMBER ?? "");
    if (number === undefined) throw new Error("TWILIO_NUMBER must be E.164.");
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
      { headers: { authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { incoming_phone_numbers?: IncomingNumber[] };
    const mine = body.incoming_phone_numbers?.find(
      (candidate) => candidate.phone_number === (number as E164),
    );
    expect(mine).toBeDefined();
    // A number with no SMS webhook configured never reaches this office: Twilio accepts the text and
    // drops it, which from the office's side looks like a quiet day.
    expect(mine?.sms_url ?? "").not.toBe("");
  });
});
