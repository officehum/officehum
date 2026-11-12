/**
 * Reading a provider's HTTP response without trusting its size.
 *
 * A response is refused before its body is read when it was redirected or its headers are oversized,
 * and while it is read once the body passes `limit` bytes. Every outbound call in this package reads
 * through here, so no caller can forget the header checks (one copy of this loop had).
 */

const MAX_HEADERS = 200;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_NAME = 200;
const MAX_HEADER_VALUE = 8192;

export interface BoundedReadOptions {
  /** The most body bytes that will be read before the response is refused. */
  readonly limit: number;
  /** The message of the error thrown for a refused or unreadable response. */
  readonly invalid: string;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // Cancelling is best effort: the caller is already failing with its own error.
  }
}

/**
 * The response body as UTF-8 text; a response with no body reads as the empty string.
 *
 * An abort rejects with the signal's reason, not with `invalid`, so a caller can tell "the provider
 * answered badly" from "we stopped waiting".
 */
export async function readBoundedText(
  response: Response,
  signal: AbortSignal,
  options: BoundedReadOptions,
): Promise<string> {
  if (response.redirected) throw new Error(options.invalid);
  const headers = [...response.headers];
  if (
    headers.length > MAX_HEADERS ||
    headers.reduce((total, [key, value]) => total + key.length + value.length, 0) >
      MAX_HEADER_BYTES ||
    headers.some(([key, value]) => key.length > MAX_HEADER_NAME || value.length > MAX_HEADER_VALUE)
  ) {
    throw new Error(options.invalid);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), aborted]);
      } catch (error) {
        if (signal.aborted) cancelReader(reader);
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (next.done) break;
      length += next.value.byteLength;
      if (length > options.limit) {
        cancelReader(reader);
        throw new Error(options.invalid);
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A native stream may keep its read pending while cancellation stalls.
    }
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new Error(options.invalid);
  }
}

/** The response body as a JSON object; anything else, including no body, is refused as `invalid`. */
export async function readBoundedJsonObject(
  response: Response,
  signal: AbortSignal,
  options: BoundedReadOptions,
): Promise<Record<string, unknown>> {
  const text = await readBoundedText(response, signal, options);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(options.invalid);
  }
}
