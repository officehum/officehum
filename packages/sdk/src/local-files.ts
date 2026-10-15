import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertId,
  assertMetadata,
  assertName,
  assertRef,
  assertSignature,
} from "./file-validation.js";
import type { FileMetadata, FileRef, FileStore } from "./files.js";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function localFileStore(dir: string): FileStore {
  const root = resolve(dir);

  return {
    async put(input) {
      const name = input.name;
      const mimeType = input.mimeType;
      const bytes = Uint8Array.from(input.bytes);
      const metadata = structuredClone(input.metadata);
      assertName(name);
      assertMetadata(metadata);
      assertSignature(bytes, mimeType);
      if (typeof mimeType !== "string" || mimeType.trim().length === 0) {
        throw new Error("Invalid file MIME type");
      }

      await mkdir(root, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(root, ".staging-"));
      try {
        let ref = createRef(newId(), name, mimeType, bytes, metadata);
        await writeFile(join(staging, name), bytes, { flag: "wx", mode: 0o600 });
        await writeFile(join(staging, "meta.json"), JSON.stringify(ref), {
          flag: "wx",
          mode: 0o600,
        });
        for (;;) {
          if (await exists(join(root, ref.id))) {
            ref = { ...ref, id: newId() };
            await writeFile(join(staging, "meta.json"), JSON.stringify(ref), { mode: 0o600 });
            continue;
          }
          try {
            await rename(staging, join(root, ref.id));
            return structuredClone(ref);
          } catch (error) {
            if (!isCollision(error)) throw error;
            ref = { ...ref, id: newId() };
            await writeFile(join(staging, "meta.json"), JSON.stringify(ref), { mode: 0o600 });
          }
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    get(id) {
      return readStored(root, id);
    },
    async info(id) {
      return (await readStored(root, id))?.ref;
    },
  };
}

async function readStored(
  root: string,
  id: string,
): Promise<{ ref: FileRef; bytes: Uint8Array } | undefined> {
  assertId(id);
  let directory: Stats;
  try {
    directory = await lstat(join(root, id));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error("Invalid file directory");

  const metadataPath = join(root, id, "meta.json");
  const metadataStat = await lstat(metadataPath);
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile())
    throw new Error("Invalid file metadata entry");
  const metadataHandle = await open(metadataPath, constants.O_RDONLY | NOFOLLOW);
  let ref: FileRef;
  try {
    const stat = await metadataHandle.stat();
    if (!stat.isFile()) throw new Error("Invalid file metadata entry");
    const data = await metadataHandle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new Error("Corrupt file metadata");
    }
    assertRef(parsed, id);
    ref = structuredClone(parsed);
  } finally {
    await metadataHandle.close();
  }

  const payloadPath = join(root, id, ref.name);
  const payloadStat = await lstat(payloadPath);
  if (payloadStat.isSymbolicLink() || !payloadStat.isFile())
    throw new Error("Invalid file payload");
  const payloadHandle = await open(payloadPath, constants.O_RDONLY | NOFOLLOW);
  let bytes: Uint8Array;
  try {
    const stat = await payloadHandle.stat();
    if (!stat.isFile()) throw new Error("Invalid file payload");
    bytes = Uint8Array.from(await payloadHandle.readFile());
  } finally {
    await payloadHandle.close();
  }
  if (bytes.length !== ref.size || hash(bytes) !== ref.sha256)
    throw new Error("File integrity check failed");
  return { ref: structuredClone(ref), bytes: Uint8Array.from(bytes) };
}

function createRef(
  id: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  metadata: FileMetadata,
): FileRef {
  return {
    id,
    name,
    mimeType,
    size: bytes.byteLength,
    sha256: hash(bytes),
    createdAt: new Date().toISOString(),
    metadata,
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function newId(): string {
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = ID_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `file_${encoded}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isCollision(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}
