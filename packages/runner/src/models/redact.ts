/**
 * Keeps a provider's key out of its own error text. Some providers quote the key, or
 * part of it, when they refuse it ("Incorrect API key provided: pk-ab…yz"), and pi-ai puts that text
 * in the failed assistant message, which Pi Durable stores with the conversation. This wraps a
 * provider so that every error it reports is checked against the key the request carried (the one
 * `Models` just resolved, stored or from the environment): an authentication failure is replaced by
 * the office's own sentence, and any other error loses every run of 8 or more characters it shares
 * with the key. Nothing else about the provider changes.
 */
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Provider,
} from "@earendil-works/pi-ai";

/** The shortest run of a key's characters taken to be a quotation of it. */
const QUOTED_RUN = 8;
const AUTHENTICATION =
  /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}key|incorrect.{0,20}key|authentication/i;

export function redactKeyErrors<P extends Provider>(provider: P): P {
  const guard = (
    stream: AssistantMessageEventStream,
    key: string | undefined,
  ): AssistantMessageEventStream => {
    if (key === undefined || key === "") return stream;
    const out = createAssistantMessageEventStream();
    const clean = (message: AssistantMessage): AssistantMessage =>
      message.errorMessage === undefined
        ? message
        : { ...message, errorMessage: redactedError(provider.name, message.errorMessage, key) };
    void (async () => {
      // A provider reports failures as events, never by throwing, so every event comes through.
      for await (const event of stream) {
        out.push(event.type === "error" ? { ...event, error: clean(event.error) } : event);
      }
      out.end();
    })();
    return out;
  };
  return {
    ...provider,
    stream: (model, context, options) =>
      guard(provider.stream(model, context, options), options?.apiKey),
    streamSimple: (model, context, options) =>
      guard(provider.streamSimple(model, context, options), options?.apiKey),
  };
}

/** The error text to keep, given the key the request carried. */
export function redactedError(providerName: string, text: string, key: string): string {
  if (AUTHENTICATION.test(text)) {
    return `${providerName} refused the API key (authentication failed). An owner can check it with test_model_key and set it again with set_model_key.`;
  }
  // Each run of the text found in the key, at least QUOTED_RUN long, goes as one piece.
  let redacted = "";
  let at = 0;
  while (at < text.length) {
    let length = 0;
    if (key.includes(text.slice(at, at + QUOTED_RUN)) && at + QUOTED_RUN <= text.length) {
      length = QUOTED_RUN;
      while (at + length < text.length && key.includes(text.slice(at, at + length + 1))) length++;
    }
    if (length > 0) {
      redacted += "[key]";
      at += length;
    } else {
      redacted += text[at];
      at++;
    }
  }
  return redacted;
}
