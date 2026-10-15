import { expect, it } from "vitest";
import { type FileRef, fileResult, MAX_INLINE_IMAGE_BYTES } from "./index.js";

const ref: FileRef = {
  id: "file_00000000000000000000000000",
  name: "draft.txt",
  mimeType: "text/plain",
  size: 5,
  sha256: "a".repeat(64),
  createdAt: "2026-10-14T00:00:00.000Z",
  metadata: { createdBy: "role:test", source: "generated" },
};

const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
};

it("returns references only", () => {
  expect(MAX_INLINE_IMAGE_BYTES).toBe(100_000);
  expect(fileResult([ref])).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          files: [{ id: ref.id, name: ref.name, mimeType: ref.mimeType, size: ref.size }],
        }),
      },
    ],
    details: { files: [ref.id] },
  });
  expect(JSON.stringify(fileResult([ref]))).not.toContain("createdBy");
  expect(JSON.stringify(fileResult([ref]))).not.toContain(ref.sha256);
});

it("refuses too many refs", () => {
  expect(() => fileResult(Array.from({ length: 101 }, () => ref))).toThrow();
});

it("accepts exactly the decoded preview limit", () => {
  const result = fileResult([ref], { preview: { bytes: png(100_000), mimeType: "image/png" } });
  const image = result.content[1];
  expect(image?.type).toBe("image");
  if (image?.type !== "image") throw new Error("Expected image");
  expect(Buffer.from(image.data, "base64").length).toBe(100_000);
  expect(result.details).toEqual({ files: [ref.id] });
});

it("rejects a decoded preview one byte above the limit", () => {
  expect(() =>
    fileResult([ref], { preview: { bytes: png(100_001), mimeType: "image/png" } }),
  ).toThrow();
});

it.each(["text/plain", "image/jpeg"])("refuses PNG preview mislabeled %s", (mimeType) => {
  expect(() => fileResult([ref], { preview: { bytes: png(20), mimeType } })).toThrow();
});

it("rejects bad preview bytes", () => {
  expect(() =>
    fileResult([ref], { preview: { bytes: new Uint8Array(20), mimeType: "image/png" } }),
  ).toThrow();
});

it("supports an empty result", () => {
  expect(fileResult([])).toEqual({
    content: [{ type: "text", text: '{"files":[]}' }],
    details: { files: [] },
  });
});

it("rejects malformed reference IDs", () => {
  expect(() => fileResult([{ ...ref, id: "../secret" }])).toThrow();
});

it("rejects unsafe names", () => {
  expect(() => fileResult([{ ...ref, name: "../secret.txt" }])).toThrow();
});

it("rejects invalid sizes", () => {
  expect(() => fileResult([{ ...ref, size: Number.MAX_SAFE_INTEGER + 1 }])).toThrow();
});

it.each(["x".repeat(256), "image/png\u0000evil"])("rejects unsafe MIME types %j", (mimeType) => {
  expect(() => fileResult([{ ...ref, mimeType }])).toThrow();
});

const previewSignatures = [
  ["JPEG", "image/jpeg", [0xff, 0xd8, 0xff]],
  ["GIF87a", "image/gif", Array.from(new TextEncoder().encode("GIF87a"))],
  ["GIF89a", "image/gif", Array.from(new TextEncoder().encode("GIF89a"))],
  [
    "WebP",
    "image/webp",
    [...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")],
  ],
] as const;

it.each(previewSignatures)("accepts a correctly signed %s preview", (_label, mimeType, prefix) => {
  const result = fileResult([ref], { preview: { bytes: Uint8Array.from(prefix), mimeType } });
  expect(result.content[1]).toMatchObject({ type: "image", mimeType });
});

it.each([
  ["PNG", "image/png", [137, 80, 78, 71, 13, 10, 26]],
  ["JPEG", "image/jpeg", [0xff, 0xd8]],
  ["GIF", "image/gif", [71, 73, 70, 56, 55]],
  [
    "WebP",
    "image/webp",
    [...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEB")],
  ],
] as const)("rejects a truncated %s signature", (_label, mimeType, prefix) => {
  expect(() =>
    fileResult([ref], { preview: { bytes: Uint8Array.from(prefix), mimeType } }),
  ).toThrow();
});
