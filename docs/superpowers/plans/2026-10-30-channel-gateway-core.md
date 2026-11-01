# Channel gateway core (RASF-3160) — design

2026-10-30. Branched on top of `feat/rasf-3162-sms`, because `packages/channels` does not exist on `main` yet.

## Why now

Email and SMS each carry their own copy of the same six facts:

| fact | email today | SMS today |
| --- | --- | --- |
| verify the sender is real | Resend signature (`resend-listener.ts`) | Twilio HMAC (`channels/signature.ts`) |
| dedupe a redelivery | inbox table | `sms_inbound(message_sid)` |
| one conversation per contact | `inbound-session.ts` | `sms-intake.ts` |
| registered vs unknown sender | reply matching | contact phone match |
| provenance and fence | inbox | intake |
| refuse to send where we must not | `deliverableChannel` | no `send` member at all |

A third channel (web chat, RASF-3163) would be the third copy, and the third copy is where one of these quietly differs. That is not a hypothetical: the red-team suite already showed the inbound-marker path lives in one channel's harness and nowhere else.

**This ticket changes no observable behaviour.** The 1289 existing tests are the specification; any of them that needs editing is a finding to report, not a line to adjust.

## The shape

```
packages/channels/src/
  adapter.ts       ChannelAdapter (inbound) + OutboundAdapter (separate, optional)
  gateway.ts       verify → parse → dedupe → opt-out → rate limit → resolve → dispatch
  registry.ts      channel name → adapters; outbound lookup is how SMS stays impossible
  resolve.ts       SenderResolver: address/number → registered(contactId) | unknown
  intake.ts        what happens next: a conversation, or a callback ticket for a person
  route.ts         the reply route a conversation carries (SMS answers by email)
  twilio.ts        unchanged, now plugged in
  resend.ts        the Resend adapter, moved — not rewritten
```

### Two interfaces, on purpose

`ChannelAdapter` has no outbound member. `OutboundAdapter` is a **separate** interface that a transport may implement. The gateway's outbound dispatcher looks up `outbound.get(channel)`; when nothing is registered it throws `NoAdapterError`.

That is the whole of "no SMS can be sent": not a check, an empty slot. The existing `deliverableChannel` guard stays as the second layer at the tool boundary.

### One dedupe table

Migration **v7**: `channel_inbound(channel, external_id, received_at, PRIMARY KEY (channel, external_id))`, backfilled from `sms_inbound` and from the email inbox's own record of handled messages, then `sms_inbound` dropped in the same rebuild.

Keyed by `(channel, external_id)` and not by id alone, because a MessageSid and a Resend message id are different namespaces and a coincidence between them must not swallow a real message.

### The reply route is a fact on the conversation

An SMS conversation records `replyBy: { channel: "email", to: <address on file> }`. The agent's `send_message` reads the route rather than guessing, and a conversation with no route can only produce a callback ticket. This is what makes "reply by email to a text" a property of the data instead of a sentence in a prompt.

### Provenance once

The gateway marks every inbound message `external` and fences the body. Channels do not each decide; a channel that forgot would be invisible, which is exactly how the marker guard ended up only in one harness.

## The proof that it is a core

One test implements a **fake web-chat adapter** — verify, parse, ack, nothing else — registers it, and drives a message end to end: dedupe, resolve, conversation, provenance, refusal to reply outbound. If adding a third channel needs a line anywhere outside that adapter, this is not a gateway core yet.

## Out of scope

* Any behaviour change to email or SMS, including the reply wording.
* Web chat's UI (RASF-3163).
* A durable outbound queue: email still sends synchronously on the approval path. When a queue arrives it belongs behind `OutboundAdapter.deliver`, and this design leaves it that room.
* Rate limiting for email: SMS has one because an unknown number can text in; email's equivalent is the provider's own reputation system, and inventing a local ceiling here would be a decision without a failure to justify it.

## Files that should get smaller

`resend-listener.ts` becomes a route table of adapters. `resend-inbox.ts`, `resend-inbound.ts` and `sms-intake.ts` should lose their dedupe and provenance code to the gateway. If a file does not shrink, say why in the PR.