/**
 * Test helpers: the fixtures, a store to put them in, and a way to call a tool directly. Kept out of
 * the build (see `tsconfig.json`), typechecked by `tsconfig.test.json`.
 */

import { readFileSync } from "node:fs";
import type { FileMetadata, VersionedFileRef, VersionedFileStore } from "@officehum/sdk";
import {
  DEFAULT_LIMITS,
  type DocumentLease,
  type LeasedInput,
  resolvePaperInterpreter,
} from "@officehum/tools-paper-office";
import type { DataPack } from "./pack.js";

export const FIXTURES = new URL("../fixtures/", import.meta.url);

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

/** The interpreter the host configured, or `undefined` when there is none. */
export function configuredInterpreter(): string | undefined {
  return resolvePaperInterpreter(process.env);
}

const MIME: Readonly<Record<string, string>> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
  parquet: "application/vnd.apache.parquet",
};

/** Puts bytes into a store under `name`, as an upload or as a file from outside the office. */
export async function putFile(
  store: VersionedFileStore,
  name: string,
  bytes: Uint8Array = fixture(name),
  source: FileMetadata["source"] = "uploaded",
): Promise<VersionedFileRef> {
  return store.put({
    bytes,
    name,
    mimeType: MIME[name.split(".").pop() ?? ""] ?? "application/octet-stream",
    metadata: {
      createdBy: "person:test",
      source,
      ...(source === "external" ? { provenance: "external" as const } : {}),
    },
  });
}

export function leasedInput(ref: VersionedFileRef): LeasedInput {
  return {
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format: "xlsx",
    sha256: ref.sha256,
    size: ref.size,
    writable: false,
  };
}

export function leaseOf(inputs: readonly LeasedInput[], taskId = "task:1"): DocumentLease {
  return {
    leaseId: "lease:data",
    taskId,
    inputs,
    outputFormats: ["xlsx"],
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

export interface CalledTool {
  readonly output: { readonly type: string; readonly text?: string; readonly data?: string }[];
  readonly isError?: boolean;
  readonly details: Record<string, unknown>;
  /** Every text block, joined. */
  readonly text: string;
}

let calls = 0;

/** Calls one of the pack's tools as Pi Durable would, under a fresh call id unless one is given. */
export async function callTool(
  pack: DataPack,
  name: string,
  args: Record<string, unknown>,
  callId = `call-${++calls}`,
): Promise<CalledTool> {
  const tool = pack.tools.find((entry) => entry.name === name) as unknown as {
    execute(args: unknown, api: unknown): Promise<Omit<CalledTool, "text">>;
  };
  const result = await tool.execute(args, { taskId: "task:1", conversationId: "conv:1", callId });
  return { ...result, text: result.output.map((block) => block.text ?? "").join("") };
}

/** The rows of a Markdown table in a tool's text, header first, as trimmed cells. */
export function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .map((line) =>
      line
        .slice(2, -2)
        .split(" | ")
        .map((cell) => cell.trim()),
    );
}

/** The fixture sales file's figures, summed in integer cents by this test code, not by DuckDB. */
export function salesTotals(): { cents: bigint; byRegion: Map<string, bigint>; rows: number } {
  const lines = new TextDecoder().decode(fixture("sales.csv")).trim().split("\n").slice(1);
  const byRegion = new Map<string, bigint>();
  let total = 0n;
  for (const line of lines) {
    const fields = line.split(",");
    const amount = BigInt((fields[7] ?? "0").replace(".", ""));
    total += amount;
    const region = fields[3] ?? "";
    byRegion.set(region, (byRegion.get(region) ?? 0n) + amount);
  }
  return { cents: total, byRegion, rows: lines.length };
}

/** Cents as the decimal text DuckDB prints for DECIMAL(38,6): `1234.560000`. */
export function decimalText(cents: bigint): string {
  const negative = cents < 0n;
  const value = negative ? -cents : cents;
  return `${negative ? "-" : ""}${value / 100n}.${String(value % 100n).padStart(2, "0")}0000`;
}
