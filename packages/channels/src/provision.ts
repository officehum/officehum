import { type E164, parseE164 } from "./adapter.js";

/**
 * Where a company's number comes from.
 *
 * There is no Twilio account behind this build, so the interface exists before any implementation that
 * could spend money: a caller depends on `provision(companyId)` and gets a number, and the fake below
 * satisfies it without a network, a credential or a card on file. The real one, when there is one,
 * replaces the object and nothing at the call site.
 */
export interface NumberProvisioner {
  provision(companyId: string): Promise<{ readonly number: E164 }>;
}

/**
 * Twilio's documented "magic" US number, from 555-0100–555-0199 — the range reserved for fiction, which
 * Twilio routes but no person receives. It is a real, valid E.164 number, so a fake-provisioned office
 * behaves like a provisioned one; it is nobody's number, so a mistake in a test cannot text a stranger.
 */
export const FAKE_NUMBER = "+15005550006";

/**
 * A provisioner that hands out one reserved number and records who asked.
 *
 * `calls` is the whole point of it being a class rather than a constant: a test asserts that a company
 * was provisioned exactly once, and that a second office did not quietly share the first one's number.
 * Both the company id and the number it got are kept, because "who was provisioned" and "with what" are
 * two different questions a later assertion asks.
 */
export class FakeNumberProvisioner implements NumberProvisioner {
  readonly calls: Array<{ readonly companyId: string; readonly number: E164 }> = [];
  readonly #number: E164;

  constructor(number: string = FAKE_NUMBER) {
    const parsed = parseE164(number);
    if (parsed === undefined) throw new Error("A fake provisioner still needs an E.164 number.");
    this.#number = parsed;
  }

  provision(companyId: string): Promise<{ readonly number: E164 }> {
    if (companyId.trim() === "") {
      throw new Error("A number is provisioned for a company, not for nobody.");
    }
    this.calls.push({ companyId, number: this.#number });
    return Promise.resolve({ number: this.#number });
  }
}
