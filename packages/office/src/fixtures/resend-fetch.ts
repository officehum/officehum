import { randomUUID } from "node:crypto";

type Saved = { payload: string; acceptedAt: number; id: string };

export class ResendFetchFixture {
  now = Date.parse("2030-01-01T00:00:00Z");
  posts = 0;
  acceptances = 0;
  loseNextResponse = false;
  holdNextResponse = false;
  status?: number;
  responseBody?: string;
  readonly requests: { key: string; payload: string; authorization: string | null }[] = [];
  private readonly saved = new Map<string, Saved>();
  private pauseLostResponse = false;
  private lostResponseReached: (() => void) | undefined;

  loseResponseUntilAbort(): Promise<void> {
    this.loseNextResponse = true;
    this.pauseLostResponse = true;
    return new Promise<void>((resolve) => {
      this.lostResponseReached = resolve;
    });
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    if (String(input) !== "https://api.resend.com/emails" || init.method !== "POST") {
      return new Response(JSON.stringify({ name: "not_found" }), { status: 404 });
    }
    this.posts += 1;
    const headers = new Headers(init.headers);
    const key = headers.get("Idempotency-Key") ?? "";
    const payload = String(init.body ?? "");
    this.requests.push({ key, payload, authorization: headers.get("Authorization") });
    if (this.holdNextResponse) {
      this.holdNextResponse = false;
      await new Promise<void>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    if (this.status !== undefined) {
      return new Response(this.responseBody ?? JSON.stringify({ name: "fixture_error" }), {
        status: this.status,
      });
    }
    const prior = this.saved.get(key);
    if (prior !== undefined && this.now - prior.acceptedAt < 24 * 60 * 60 * 1000) {
      if (prior.payload !== payload) {
        return new Response(JSON.stringify({ name: "invalid_idempotent_request" }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({ id: prior.id }), { status: 200 });
    }
    const saved = { payload, acceptedAt: this.now, id: randomUUID() };
    this.saved.set(key, saved);
    this.acceptances += 1;
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      this.lostResponseReached?.();
      this.lostResponseReached = undefined;
      if (this.pauseLostResponse) {
        this.pauseLostResponse = false;
        await new Promise<void>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`synthetic response loss ${headers.get("Authorization")} ${payload}`);
    }
    return new Response(this.responseBody ?? JSON.stringify({ id: saved.id }), { status: 200 });
  };
}
