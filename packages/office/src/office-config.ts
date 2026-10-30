/**
 * The office's own configuration: the few facts about this office that have to outlive a process.
 *
 * There is a deliberate asymmetry between this and the board. The board is the office's record of work
 * — append-only, one writer, a customer's history. This is a handful of settings that name the office
 * to the outside world, and it is a small JSON file so an operator can read it (`cat office.config.json`)
 * and a provisioner can write it without opening a database. The SMS business number is the first of
 * them: a webhook arrives at an office that is already running, and the number it was addressed to has
 * to be a stored fact rather than an argument somebody remembered to pass.
 *
 * The file is never partly written. A config that a crash truncated would read as an office with no
 * number, which is precisely the failure that looks like a working server: every text would be
 * refused as somebody else's. So a write goes to a sibling temp file and is renamed over the original,
 * which is atomic on the filesystems this runs on.
 *
 * A file that exists and cannot be read is an error, not an empty config. The empty config means "no
 * number provisioned yet"; a corrupt one means somebody has to look, and silently treating the second
 * as the first would hide a real fault behind a plausible one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type E164, parseE164 } from "@officehum/channels";

/** The file name, beside the board and the calendars in the state directory. */
export const OFFICE_CONFIG_FILE = "office.config.json";

/** What the file holds. `version` is there so a later shape can refuse an older one knowingly. */
export type OfficeConfigFile = {
  readonly version: 1;
  readonly sms?: { readonly businessNumber?: string };
};

export interface OfficeConfig {
  /**
   * The number this office receives texts on, or `undefined` before one is provisioned.
   * Undefined is not an error here: the webhook route decides what to do about it, and a missing
   * number is a host that has not bought the channel rather than a broken config.
   */
  smsBusinessNumber(): E164 | undefined;
  /** Write the number a provisioner handed out. This is the `NumberSink` a provisioner takes. */
  setSmsBusinessNumber(number: E164): void;
}

function readFile(path: string): OfficeConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw new Error(`Office config ${path} could not be read.`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Office config ${path} is not JSON.`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Office config ${path} must be a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(
      `Office config ${path} is version ${String(record.version)}; this build reads 1.`,
    );
  }
  return parsed as OfficeConfigFile;
}

/**
 * Open the config at `path`, creating nothing until something is written.
 *
 * Every read goes back to the file rather than to a value captured at startup, because the writer is
 * a provisioner in another process and a cached number would be the one fact this file exists to keep
 * current. The file is a few hundred bytes; a read per webhook route decision is not a cost worth a
 * cache that can be wrong.
 */
export function openOfficeConfig(path: string): OfficeConfig {
  return {
    smsBusinessNumber() {
      const value = readFile(path).sms?.businessNumber;
      if (value === undefined) return undefined;
      const number = parseE164(value);
      // A number that is not E.164 is a config a person edited by hand, so it is refused loudly here
      // rather than compared against every incoming message and never matching.
      if (number === undefined) {
        throw new Error(`Office config ${path} holds an SMS number that is not E.164: ${value}.`);
      }
      return number;
    },
    setSmsBusinessNumber(number) {
      mkdirSync(dirname(path), { recursive: true });
      const next: OfficeConfigFile = {
        ...readFile(path),
        version: 1,
        sms: { businessNumber: number },
      };
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      renameSync(temporary, path);
    },
  };
}
