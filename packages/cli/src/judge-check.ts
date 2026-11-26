/**
 * `officehum judge-check FIXTURE [--judge provider/model]`: runs a judge model over a
 * labelled set of replies for one claim, with the exact prompt an eval trial uses, and prints how
 * often its verdict matches the label. It is how a judge is measured before its verdicts are
 * trusted in a suite; `packages/sdk/src/fixtures/judged-promise-replies.json` is the set for the
 * promise claim the Bookkeeper and Front Desk suites judge.
 *
 * The judge defaults to the model new role conversations run on. It calls a live provider, so it
 * needs that provider's key; a provider failure stops the check, since it says nothing about
 * agreement. Exits 0 when every case agrees, 1 otherwise.
 */

import { readFile } from "node:fs/promises";
import { PAPER_MODEL_REF } from "@officehum/provider-paper";
import { modelJudge } from "@officehum/runner";
import { checkJudge, formatIssue, validateJudgeFixture } from "@officehum/sdk";
import type { CliDependencies, CliIo } from "./cli.js";
import { parseModelRef, runModels } from "./run.js";
import { UsageError } from "./usage-error.js";

export const JUDGE_CHECK_USAGE = "officehum judge-check FIXTURE [--judge provider/model]";

export async function runJudgeCheckCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  let file: string | undefined;
  let judgeSpec: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (token === "--judge") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--judge requires a value.\nusage: ${JUDGE_CHECK_USAGE}`);
      }
      judgeSpec = value;
      index += 1;
    } else if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}\nusage: ${JUDGE_CHECK_USAGE}`);
    } else if (file !== undefined) {
      throw new UsageError(`Only one fixture file is allowed.\nusage: ${JUDGE_CHECK_USAGE}`);
    } else {
      file = token;
    }
  }
  if (file === undefined)
    throw new UsageError(`judge-check needs a fixture file.\nusage: ${JUDGE_CHECK_USAGE}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the fixture file ${file}: ${String(error)}.`);
  }
  const checked = validateJudgeFixture(parsed, file);
  if (!checked.ok) {
    for (const issue of checked.issues) io.error(formatIssue(issue));
    return 1;
  }
  const ref = judgeSpec === undefined ? PAPER_MODEL_REF : parseModelRef(judgeSpec, "--judge");
  const judge = modelJudge(runModels(ref, dependencies, "judge-check"));

  const result = await checkJudge(checked.value, judge);
  io.output(`Judge: ${result.model} (prompt ${result.promptVersion})`);
  io.output(`Claim: ${result.claim}`);
  for (const entry of result.cases) {
    const reply = entry.reply.replace(/\s+/g, " ");
    const short = reply.length > 90 ? `${reply.slice(0, 87)}...` : reply;
    const head = entry.agreed ? "agree   " : "DISAGREE";
    const judged = entry.verdict ?? `no verdict, answered ${JSON.stringify(entry.raw)}`;
    io.output(`${head} ${entry.kind}: labelled ${entry.label}, judged ${judged}: ${short}`);
  }
  const percent = Math.round((result.agreed / result.total) * 100);
  io.output(`Agreement: ${result.agreed}/${result.total} (${percent}%)`);
  return result.agreed === result.total ? 0 : 1;
}
