import { describe, expect, it } from "vitest";
import { readBoundedJsonObject, readBoundedText } from "./bounded-http.js";

const options = { limit: 16, invalid: "Response was invalid." };
const signal = () => new AbortController().signal;

describe("bounded HTTP reader", () => {
  it("reads a body within the limit, and an absent body as empty text", async () => {
    await expect(readBoundedText(new Response("hello"), signal(), options)).resolves.toBe("hello");
    await expect(readBoundedText(new Response(null), signal(), options)).resolves.toBe("");
  });

  it("refuses a body past the limit and bytes that are not UTF-8", async () => {
    await expect(readBoundedText(new Response("x".repeat(17)), signal(), options)).rejects.toThrow(
      options.invalid,
    );
    await expect(
      readBoundedText(new Response(new Uint8Array([0xff, 0xfe])), signal(), options),
    ).rejects.toThrow(options.invalid);
  });

  it("refuses oversized headers before reading the body", async () => {
    const tooLong = new Response("ok", { headers: { "x-long": "v".repeat(8193) } });
    await expect(readBoundedText(tooLong, signal(), options)).rejects.toThrow(options.invalid);
    const tooMany = new Response("ok", {
      headers: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`x-h${index}`, "v"])),
    });
    await expect(readBoundedText(tooMany, signal(), options)).rejects.toThrow(options.invalid);
  });

  it("rejects with the abort reason, not the invalid error, when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timeout"));
    await expect(
      readBoundedText(new Response("hello"), controller.signal, options),
    ).rejects.toThrow("timeout");
  });

  it("returns a JSON object and refuses anything else", async () => {
    await expect(
      readBoundedJsonObject(new Response('{"a":1}'), signal(), options),
    ).resolves.toEqual({ a: 1 });
    for (const body of ["[1]", "null", "nope", ""]) {
      await expect(readBoundedJsonObject(new Response(body), signal(), options)).rejects.toThrow(
        options.invalid,
      );
    }
  });
});
