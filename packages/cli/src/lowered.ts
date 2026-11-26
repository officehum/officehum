/**
 * The standing set of lowered safeguards, as `officehum run` and the runtime print it at start
 *: which of a role's safeguards its overlays hold below what the role ships, and, in an
 * office, where each came from. See docs/design/overlay-rules.md.
 */

/** A lowered safeguard as the SDK (`loweredGuards`) or the overlay store reports it. */
export interface StandingLowered {
  readonly id: string;
  readonly sentence: string;
  readonly source?:
    | { readonly version: number }
    | { readonly import: number }
    | { readonly officeFile: string }
    | { readonly upgrade: string | null }
    | { readonly beforeRecords: number };
}

/** Where a lowering came from, in words. */
function from(source: NonNullable<StandingLowered["source"]>): string {
  if ("officeFile" in source) return `the office file's overlay ${source.officeFile}`;
  if ("import" in source) return `version ${source.import}, imported from files`;
  if ("upgrade" in source) return `a role package upgrade (${source.upgrade ?? "unversioned"})`;
  if ("beforeRecords" in source) return `version ${source.beforeRecords}, before records were kept`;
  return `version ${source.version}`;
}

/** The lines to print for `subject` (an agent or a role's name); none when nothing is lowered. */
export function loweredLines(subject: string, lowered: readonly StandingLowered[]): string[] {
  if (lowered.length === 0) return [];
  const count = `${lowered.length} safeguard${lowered.length === 1 ? "" : "s"}`;
  return [
    `${subject} runs with ${count} lowered below its role's defaults:`,
    ...lowered.map(
      (guard) =>
        `  ${guard.id}: ${guard.sentence}${guard.source === undefined ? "" : ` (${from(guard.source)})`}`,
    ),
  ];
}
