/**
 * The interviewer: the loop that asks the questions `questions.ts` holds, checks every answer as it
 * comes, and writes one `ROLE_SPEC.md` — but only a document that parses.
 *
 * What it guarantees, and why each one matters:
 *
 * - **Nothing is written that the generator would refuse.** At the end of the conversation the answers
 *   are checked with `parseRoleSpec` *and* with the merged manifest's own checks, because the parser
 *   deliberately does not re-derive the SDK's field shapes and the generator runs `validateManifest`
 *   before it writes a package. A document that gets past both is one `officehum-role generate`
 *   accepts; one that does not is reported and never written.
 * - **Only the questions behind a problem are asked again.** A problem is reported at a spec path, and
 *   every answer knows the path it lands at, so the person is not walked through the whole interview
 *   twice (`questionsBehind`).
 * - **Asking again terminates.** Each answer is put to a person at most `MAX_ATTEMPTS` times, the
 *   re-ask rounds are capped, and a round that changes nothing stops immediately. What is left is
 *   reported: "nothing was written" is an answer, not a failure to be hidden.
 * - **The interview is data and an io.** The same questions run at a terminal (`terminalIO`) and from a
 *   script (`scriptedIO`), which is what lets the portal run them later without a terminal behind it.
 *
 * See docs/design/role-spec.md, "The interview".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Issue } from "@officehum/sdk";
import {
  type Answer,
  AnswerStore,
  type Ask,
  type Asked,
  askOf,
  asksFor,
  problemsOf,
  problemWith,
  questionsBehind,
  questionsOfStep,
  STEPS,
  specDocument,
} from "./questions.js";
import { parseRoleSpec, ROLE_SPEC_FILE, type RoleSpec } from "./spec.js";

/**
 * How many times one answer is put to a person, counting the first asking. Three is enough for a
 * person to hear why an answer was refused, fix it, and be told again once more before the interview
 * gives up on it and reports what is still wrong.
 */
export const MAX_ATTEMPTS = 3;

/** How many times the answers are checked and the questions behind the problems asked again. */
export const MAX_ROUNDS = 4;

/** What an io has to be able to do for an interview to run through it. */
export interface InterviewIo {
  /** Writes a line a person reads: a step's title, its introduction, or the end of the interview. */
  readonly say: (line: string) => void;
  /** Asks one question and gives the answer back. */
  readonly ask: (ask: Ask) => Promise<Answer>;
  /** Writes the finished document. */
  readonly write: (path: string, text: string) => void;
  /** Releases whatever the io holds — a terminal holds the input stream; a script holds nothing. */
  readonly close?: () => void;
}

/** Thrown when the person stops an interview part way through, or its input ends. */
export class InterviewCancelledError extends Error {
  constructor(reason = "the interview was stopped before it finished") {
    super(reason);
    this.name = "InterviewCancelledError";
  }
}

export interface InterviewOptions {
  /** Where the spec is written; the role spec's own file name, in this directory, by default. */
  readonly outPath?: string;
}

/** What an interview did: the document it wrote, or the reasons it wrote none. */
export type InterviewResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly text: string;
      /** The spec, parsed: a host can generate from it without reading the file back. */
      readonly spec: RoleSpec;
      /** Warnings that did not refuse the document, if any. */
      readonly issues: readonly Issue[];
    }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/** What the interviewer carries while it works. */
interface Host {
  readonly io: InterviewIo;
  readonly answers: AnswerStore;
  /** How many times each answer has been put to the person. */
  readonly attempts: Map<string, number>;
  /** The answers already given, so a question is put once unless its answer is refused. */
  readonly held: Set<string>;
}

/**
 * Runs one interview through `io` and returns what it wrote. Throws `InterviewCancelledError` when
 * the person stops it, rather than writing a half-answered spec.
 */
export async function runInterview(
  io: InterviewIo,
  options: InterviewOptions = {},
): Promise<InterviewResult> {
  const host: Host = { io, answers: new AnswerStore(), attempts: new Map(), held: new Set() };
  const outPath = options.outPath ?? ROLE_SPEC_FILE;

  io.say("The role interview.");
  io.say(
    `It asks ${STEPS.length} steps of plain questions about the work and writes one ${ROLE_SPEC_FILE}, ` +
      "the document a role is generated from. Nothing is written until every answer stands; a wrong " +
      "answer is asked again with the reason.",
  );

  for (const step of STEPS) {
    const questions = questionsOfStep(step, host.answers);
    // A step whose questions do not apply asks nothing, so it is not announced either. The walk is
    // lazy: it reads the answers as they stand, so a step that a later answer brings back would be
    // announced by the next round rather than here.
    const first = questions.next();
    if (first.done === true) continue;
    io.say("");
    io.say(`— ${step.title}${step.optional === true ? " —" : ""}`);
    io.say(step.intro);
    await askQuestion(first.value, host, undefined);
    for (const asked of questions) await askQuestion(asked, host, undefined);
  }

  let issues = problemsOf(host.answers);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const errors = errorsOf(issues);
    if (errors.length === 0) break;
    const problems = questionsBehind(errors, asksFor(host.answers));
    if (problems.questions.length === 0) break;
    io.say("");
    const count = problems.questions.length;
    io.say(
      `Some answers need another look: ${count} ${count === 1 ? "question" : "questions"}. Nothing ` +
        "is written until they stand.",
    );
    const before = specDocument(host.answers);
    for (const reask of problems.questions) {
      await askQuestion({ question: reask.question, place: reask.place }, host, reask.because);
    }
    issues = problemsOf(host.answers);
    // The answers were put again and the document reads the same: another round would ask the same
    // questions the same way. Stop and report, rather than asking forever.
    if (specDocument(host.answers) === before) break;
  }

  const errors = errorsOf(issues);
  if (errors.length > 0) {
    report(io, errors, host.answers);
    return { ok: false, issues };
  }

  const text = specDocument(host.answers);
  const parsed = parseRoleSpec(text, outPath);
  // The checks above pass before this: a document that refuses here is a defect in the interview, and
  // the honest thing is to write nothing rather than a spec nobody can generate from.
  if (!parsed.ok) {
    report(io, parsed.issues, host.answers);
    return { ok: false, issues: parsed.issues };
  }

  io.write(outPath, text);
  io.say("");
  io.say(`Wrote ${outPath}.`);
  io.say(`Next: officehum-role generate ${outPath} <out-dir>`);
  return { ok: true, path: outPath, text, spec: parsed.value, issues };
}

/** The problems that refuse a document: a warning reports one it can still be written with. */
function errorsOf(issues: readonly Issue[]): readonly Issue[] {
  return issues.filter((issue) => issue.severity !== "warning");
}

/**
 * Says plainly what is left, with the question each problem belongs to, and that nothing was written.
 * The messages are the document's own, so a person hears the same problem the file would report.
 */
function report(io: InterviewIo, issues: readonly Issue[], answers: AnswerStore): void {
  const problems = questionsBehind(issues, asksFor(answers));
  io.say("");
  io.say(
    `Nothing was written. ${issues.length} ${issues.length === 1 ? "problem" : "problems"} still ` +
      "stand:",
  );
  io.say("");
  for (const reask of problems.questions) {
    io.say(`  ${label(reask.question.prompt)}`);
    for (const because of reask.because) io.say(`    ${because}`);
  }
  // A problem no answer explains is the document's own shape rather than something a person said, and
  // it is reported as it stands.
  for (const issue of problems.other) io.say(`  ${issue.message}`);
  io.say("");
  io.say("Running the interview again starts at the first question; no answers are kept.");
}

/** The first question of a prompt, for a report that names the question rather than quoting it whole. */
function label(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  const mark = collapsed.indexOf("?");
  return mark === -1 || mark > 90
    ? `"${collapsed.slice(0, 90)}"`
    : `"${collapsed.slice(0, mark + 1)}"`;
}

/**
 * Puts one question to the person, and puts it again while the answer is refused. An answer already
 * given — one entry of a list, or a question in a later round — is checked as it stands and asked
 * about only when it does not stand.
 */
async function askQuestion(
  asked: Asked,
  host: Host,
  because: readonly string[] | undefined,
): Promise<void> {
  const { place } = asked;
  // An entry of a group's list arrived with the list itself, so it counts as given.
  if (place.entry !== undefined) host.held.add(place.key);
  let reason = because;
  for (;;) {
    const problem = problemWith(asked, host.answers);
    const given = host.held.has(place.key) || host.answers.value(place.key) !== undefined;
    // A question is put again when a problem names it even though the answer itself stands: the problem
    // is the document's — a number in the role's own context, a comparison nothing can make — and this
    // answer is where it comes from.
    if (given && problem === undefined && reason === undefined) return;
    const attempts = host.attempts.get(place.key) ?? 0;
    // Out of attempts: the answer stands as it is, and the problems it leaves are reported at the end.
    if (attempts >= MAX_ATTEMPTS) return;
    host.attempts.set(place.key, attempts + 1);
    host.held.add(place.key);
    const answer = await host.io.ask(
      askOf(asked, host.answers, problem === undefined ? reason : [problem]),
    );
    host.answers.set(place.key, answer);
    // The reason a round carried has been given now; from here only this answer's own problems count.
    reason = undefined;
  }
}

/** Writes one file, making the directory it lives in when it is not there yet. */
export function writeDocument(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * Asks and answers a person at a terminal, one question at a time, through readline. A list question
 * reads lines until an empty one; a blank answer to a yes/no question is no, which its prompt says.
 *
 * Lines are read through readline's own event rather than `question()`: a terminal delivers a line when
 * it is typed, but a pipe delivers every line at once, and an interface asked one line at a time loses
 * the rest. Reading them into a queue makes `officehum-role interview out.md < answers.txt` behave the
 * way an interactive run does.
 */
export function terminalIO(): InterviewIo {
  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY === true,
  });
  /** Lines that arrived before a question was waiting for them. */
  const queued: string[] = [];
  /** The questions waiting for a line; `undefined` when the input ends under them. */
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;

  readline.on("line", (line) => {
    const next = waiting.shift();
    if (next === undefined) queued.push(line);
    else next(line);
  });
  readline.on("close", () => {
    // Ctrl-C, or the input running out: a person who stopped, rather than a person who answered
    // nothing. Every question still waiting is refused so the interview ends instead of hanging.
    ended = true;
    for (const next of waiting.splice(0)) next(undefined);
  });

  const readLine = async (query: string): Promise<string> => {
    stdout.write(query);
    const queuedLine = queued.shift();
    if (queuedLine !== undefined) return queuedLine;
    if (ended) throw new InterviewCancelledError("the input ended part way through");
    const line = await new Promise<string | undefined>((resolve) => waiting.push(resolve));
    if (line === undefined) {
      throw new InterviewCancelledError("the interview was stopped before it finished");
    }
    return line;
  };

  return {
    say: (line) => {
      stdout.write(`${line}\n`);
    },
    ask: async (ask) => {
      const lines: string[] = [];
      // The reason first: a person read why they are being asked again before the question itself.
      if (ask.because !== undefined) lines.push(`  asked again — ${ask.because}`);
      lines.push(ask.prompt);
      if (ask.help !== undefined) lines.push(`  ${ask.help}`);
      if (ask.choices !== undefined) {
        lines.push(`  one of: ${ask.choices.map((choice) => `"${choice}"`).join(", ")}`);
      }
      lines.push(ask.optional === true ? "> (blank to skip) " : "> ");
      const first = lines.join("\n");
      if (ask.type !== "list") return answerOf(ask, await readLine(first));

      const entries: string[] = [];
      for (;;) {
        const entry = (await readLine(entries.length === 0 ? first : "> ")).trim();
        if (entry === "") return entries;
        entries.push(entry);
      }
    },
    write: writeDocument,
    close: () => {
      readline.close();
    },
  };
}

/** What a typed answer means: a choice as the option itself, and a yes/no as a boolean. */
function answerOf(ask: Ask, raw: string): Answer {
  const text = raw.trim();
  if (ask.type === "yes-no") {
    if (text === "") return false;
    if (/^(y|yes|true|1)$/i.test(text)) return true;
    if (/^(n|no|false|0)$/i.test(text)) return false;
    // Nothing understood it: the question's own check refuses it and says what it wanted.
    return text;
  }
  if (ask.type === "choice" && ask.choices !== undefined) {
    const chosen = ask.choices.find((choice) => choice.toLowerCase() === text.toLowerCase());
    return chosen ?? text;
  }
  return text;
}

/** A queue of attempts at one question, for a test that wants it refused before it stands. */
export interface ScriptedAttempts {
  readonly queue: readonly Answer[];
}

/** One scripted answer: the value, or a queue of attempts for a test that wants a question asked again. */
export type ScriptedAnswer = Answer | ScriptedAttempts;

export interface ScriptedIoOptions {
  /** Where to write the document. By default a script only records what it was asked to write. */
  readonly write?: (path: string, text: string) => void;
}

/** What a scripted interview was asked and written, so a test can read the conversation back. */
export interface ScriptedIo extends InterviewIo {
  /** Every question put to it, in order, with the reason when it was a second asking. */
  readonly asked: readonly Ask[];
  /** Every line it was told to say. */
  readonly said: readonly string[];
  /** Every document it was asked to write. */
  readonly written: readonly { readonly path: string; readonly text: string }[];
}

/**
 * Answers an interview from a script: one answer per question, keyed the way the interview keys them
 * (`role_id`, `tools[2].does`), or a queue of attempts for a question that must be refused first.
 *
 * A question with no scripted answer fails loudly rather than answering blank, so a test cannot pass
 * by accident; a question marked optional is answered blank, which is how a test skips one.
 */
export function scriptedIO(
  answers: Readonly<Record<string, ScriptedAnswer>>,
  options: ScriptedIoOptions = {},
): ScriptedIo {
  const queues = new Map<string, readonly Answer[]>();
  const asked: Ask[] = [];
  const said: string[] = [];
  const written: { path: string; text: string }[] = [];
  return {
    asked,
    said,
    written,
    say: (line) => {
      said.push(line);
    },
    ask: async (ask) => {
      asked.push(ask);
      if (!queues.has(ask.id)) {
        const scripted = answers[ask.id];
        if (scripted === undefined) {
          if (ask.optional === true) return "";
          throw new Error(`scriptedIO: nothing scripted for "${ask.id}" — ${ask.prompt}`);
        }
        queues.set(ask.id, scriptedAnswer(scripted));
      }
      const queue = queues.get(ask.id) ?? [];
      const [answer, ...rest] = queue;
      // The queue gives one answer each asking and then keeps giving its last, which is how a test
      // scripts an answer that never becomes valid: the interview's own bound is what stops it.
      if (rest.length > 0) queues.set(ask.id, rest);
      return answer ?? "";
    },
    write: (path, text) => {
      written.push({ path, text });
      options.write?.(path, text);
    },
  };
}

/** The attempts a scripted answer stands for: the value itself, or the queue it was given as. */
function scriptedAnswer(scripted: ScriptedAnswer): readonly Answer[] {
  return isAttempts(scripted) ? [...scripted.queue] : [scripted];
}

/** Whether a scripted answer is a queue of attempts rather than a value. */
function isAttempts(scripted: ScriptedAnswer): scripted is ScriptedAttempts {
  return typeof scripted === "object" && !Array.isArray(scripted);
}
