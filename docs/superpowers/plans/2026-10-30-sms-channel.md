# SMS channel, inbound only — implementation plan (RASF-3162)

2026-10-30. Written after reading the repo, because the issue's premise and the repo disagree.

## What the repo actually has

| Spec assumes | Reality at `344ec39` |
| --- | --- |
| `packages/channels` | Does not exist. |
| Channel gateway core (RASF-3160) | Does not exist. |
| The Resend email channel in that package | Exists, but in `packages/office/src/resend-*.ts` (`resend-inbox`, `resend-listener`, `resend-messenger`, `resend-replies`). |
| An outbox that routes by channel | No outbox. `ConsoleMessenger` records locally and performs no network request; the relay is at-least-once plus a dedupe key. |
| Routing + provenance primitives | Exist on the board (`provenance`, `relay`, `openInboundSession`) and are reusable. |

So this ticket builds the **minimum** gateway core the channel needs and says so, rather than pretending RASF-3160 landed.

## The one thing that must die

`agents/frontdesk/src/messaging.ts` accepts `channel: "email" | "sms"` and validates an E.164 target for SMS. **Outbound SMS is reachable today** through `send_message`. The owner's rule is inbound only, so this is not a flag to flip: `sms` leaves the tool's schema, and the delivery function refuses it anyway. Two layers, because a model that cannot express the call and a delivery layer that refuses it fail differently.

## Shape

```
packages/channels/
  src/adapter.ts      ChannelAdapter: inbound-only by construction — there is no send member to implement
  src/twilio.ts       TwilioAdapter: signature, parse, empty TwiML
  src/signature.ts    X-Twilio-Signature (HMAC-SHA1 over URL + sorted key/value pairs)
  src/twiml.ts        the empty <Response/>, and nothing else
  src/router.ts       inbound -> the right agent, one conversation per contact, dedupe by MessageSid
  src/registration.ts registered vs unregistered sender, and what each may do
  src/optout.ts       STOP / START per number
  src/ratelimit.ts    per-number ceiling for unregistered senders
  src/provision.ts    NumberProvisioner (interface) + FakeNumberProvisioner
```

`NumberProvisioner` is an interface with a fake because there is no Twilio account. It writes the business number into the office config and nothing else.

## Durable stores live in the board's SQLite, not in the channel package

Migration **v6** adds:

* `sms_inbound(message_sid PRIMARY KEY, received_at)` — the duplicate guard. Twilio retries; the second delivery of one MessageSid must not create a second ticket.
* `sms_optouts(number PRIMARY KEY, state CHECK (state IN ('stop','start')), at)` — recorded now so a future outbound feature inherits it without a migration.
* `sms_rate(number, window_start, count, PRIMARY KEY(number, window_start))` — the unregistered ceiling.

Why the board: it is the one durable authority in this repo, with append-only triggers and a single writer. A second SQLite file beside it would be a second source of truth about the same company's customers.

## Inbound path

1. Verify `X-Twilio-Signature`. Bad signature → 403, no board write, no log of the body (it is untrusted content).
2. Form-parse `From`, `To`, `Body`, `MessageSid`. `From`/`To` must be E.164 or the request is refused.
3. `To` must be a provisioned business number; otherwise 404.
4. Dedupe on `MessageSid` inside one `BEGIN IMMEDIATE`.
5. `STOP`/`START` are recorded against the number and produce no ticket.
6. **Registered number** (matches a contact's phone): one conversation per contact per agent, keyed by E.164, `requestId twilio:<MessageSid>`, `whenBusy: "steer"`, provenance `external`. The Front Desk replies **by email** through the existing email channel and its first-contact approval. Nothing here sends SMS.
7. **Unregistered number**: rate limit, then a **callback ticket** in Studio — the text and the number, provenance `external`, assigned to a person. The Front Desk cannot reply. If the text contains an email address, writing to it is a first contact and needs approval like any other.
8. Every response is `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, so Twilio sends nothing on its own.

Content from outside is **data**. The ticket detail says so and the marker/fence rules from RASF-3143 apply unchanged.

## The hint

The Front Desk manifest's `channels` block gains an SMS entry: inbound only, reply by email. The role's instructions say it in one sentence, because a role that believes it can text back will try.

## Mount point

`packages/office/src/resend-listener.ts` already runs a `node:http` server on `127.0.0.1` with a single hard-coded route. It becomes the central webhook router: a route table, `/webhooks/resend` unchanged, `/hooks/twilio` added. Existing export names keep working.

## Tests

* Recorded webhook fixtures; a real Twilio-shaped form body.
* Bad signature → 403 and no write.
* Duplicate `MessageSid` → delivered once, one ticket.
* Every response body is empty TwiML.
* Registered sender → email reply, first contact gated.
* Unregistered → callback ticket, and **no** email without approval.
* Rate limit holds; the third text in the window is refused and recorded.
* No code path sends SMS: the adapter type has no send member, and the delivery function throws for `sms`.
* STOP and START update the opt-out list.
* The live test is `it.skipIf` on a missing Twilio account — opt in, never default.

## Out of scope

Sending any SMS, MMS, WhatsApp, voice (RASF-3220), and the full gateway core (RASF-3160).