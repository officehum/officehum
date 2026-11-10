/**
 * JSONL framing for the Gateway Protocol: one JSON message per line, lines ended by LF.
 *
 * Only LF (0x0A) ends a frame. U+2028 and U+2029 are legal inside JSON strings and JavaScript's
 * `JSON.stringify` leaves them raw, so a reader that splits on them (as some line readers do) would
 * cut a message in half. A lone CR never ends a frame either; a CR before the LF is JSON whitespace
 * and parses away.
 */

/** The longest line a peer may send, in bytes of UTF-8, not counting the LF. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** One decoded line: the parsed JSON value, or why the line was refused. */
export type Frame =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly code: "bad_frame" | "frame_too_large";
      readonly message: string;
    };

/** Writes one message as a frame: its JSON followed by LF. */
export function encode(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

export interface LineDecoderOptions {
  /** The longest line accepted, in bytes. Defaults to {@link MAX_FRAME_BYTES}. */
  readonly maxFrameBytes?: number;
}

const LF = 0x0a;

/**
 * Splits a byte or text stream into frames. Chunks may end anywhere, including inside a line or a
 * multi-byte character; the decoder buffers until the LF arrives. A line over the limit is reported
 * once as `frame_too_large` and skipped through its LF, so one bad frame does not end the stream.
 */
export class LineDecoder {
  readonly #maxFrameBytes: number;
  readonly #text = new TextEncoder();
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true });
  #parts: Uint8Array[] = [];
  #size = 0;
  /** True while skipping the rest of a line already reported as too large. */
  #discarding = false;
  /** The first half of a character split across string chunks. */
  #highSurrogate = "";

  constructor(options: LineDecoderOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  /** Feeds the next chunk and returns every frame it completed, in order. */
  push(chunk: string | Uint8Array): Frame[] {
    const data = typeof chunk === "string" ? this.#text.encode(this.#joinSurrogates(chunk)) : chunk;
    const frames: Frame[] = [];
    let start = 0;
    while (start < data.length) {
      const lf = data.indexOf(LF, start);
      const end = lf === -1 ? data.length : lf;
      if (!this.#discarding) {
        if (this.#size + (end - start) > this.#maxFrameBytes) {
          frames.push({
            ok: false,
            code: "frame_too_large",
            message: `A line is longer than ${this.#maxFrameBytes} bytes; it was skipped. Send smaller messages.`,
          });
          this.#reset();
          this.#discarding = true;
        } else {
          // Copy: the caller may reuse its buffer before the line completes.
          this.#parts.push(data.slice(start, end));
          this.#size += end - start;
        }
      }
      if (lf === -1) break;
      if (this.#discarding) {
        this.#discarding = false;
      } else {
        const frame = this.#parse(this.#take());
        if (frame !== undefined) frames.push(frame);
      }
      start = lf + 1;
    }
    return frames;
  }

  /** Ends the stream. A last line without its LF is reported as `bad_frame`, not parsed. */
  end(): Frame[] {
    const halfCharacter = this.#highSurrogate !== "";
    this.#highSurrogate = "";
    const discarding = this.#discarding;
    const rest = this.#take();
    this.#discarding = false;
    if (discarding || (this.#isBlank(rest) && !halfCharacter)) return [];
    return [
      {
        ok: false,
        code: "bad_frame",
        message: "The stream ended in the middle of a line; every message must end with LF.",
      },
    ];
  }

  /**
   * A string chunk may end between the two halves of a character outside the Basic Multilingual
   * Plane (an emoji, say). Encoding the half alone would corrupt it, so it waits for the next chunk.
   */
  #joinSurrogates(chunk: string): string {
    const text = this.#highSurrogate + chunk;
    this.#highSurrogate = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.#highSurrogate = text.slice(-1);
      return text.slice(0, -1);
    }
    return text;
  }

  #take(): Uint8Array {
    const line = new Uint8Array(this.#size);
    let offset = 0;
    for (const part of this.#parts) {
      line.set(part, offset);
      offset += part.length;
    }
    this.#reset();
    return line;
  }

  #reset(): void {
    this.#parts = [];
    this.#size = 0;
  }

  #isBlank(line: Uint8Array): boolean {
    return line.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d);
  }

  #parse(line: Uint8Array): Frame | undefined {
    if (this.#isBlank(line)) return undefined;
    let text: string;
    try {
      text = this.#utf8.decode(line);
    } catch {
      return { ok: false, code: "bad_frame", message: "A line is not valid UTF-8." };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      // The parser's own message quotes part of the line; it is left out, because the line may be
      // large or carry something that should not be repeated into another party's log.
      return { ok: false, code: "bad_frame", message: "A line is not valid JSON." };
    }
  }
}
