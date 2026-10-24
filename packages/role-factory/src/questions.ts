/**
 * The role interview as data: the steps, the questions a person answers, how each answer is checked,
 * and where it is written into `ROLE_SPEC.md`.
 *
 * Keeping the questions as data rather than as a conversation is what lets one interview run in the
 * terminal now and in the portal later: `interview.ts` only asks, checks and writes, and every word a
 * person reads lives here. Three rules hold throughout this file:
 *
 * - **Plain language, no format words.** A question asks about the work: a tool is "safe to run this
 *   twice" rather than `replay`, work that arrives is "what work arrives for this role" rather than
 *   `accepts`, and what waits for a person is asked about, never named as a `when`. Nothing here is
 *   domain-specific: no trade, business, amount or example belongs to any one of them.
 * - **The parser is the gate.** The shapes checked here are the ones a person hears while answering;
 *   `parseRoleSpec` and the merged manifest's own checks decide whether the document is written at
 *   all. The mapping is deliberately plain data — the parser is what gives it a type.
 * - **Every answer says where it lands.** `path` is the spec path the answer is written to, so a
 *   problem reported at a path can be traced back to the question that caused it and only that
 *   question is asked again (`questionsBehind`).
 *
 * See docs/design/role-spec.md, "The interview".
 */

import {
  CHANNELS,
  DEPARTMENTS,
  GENERIC_TOOLS,
  type Issue,
  RESERVED_TOOL_NAMES,
  validateManifest,
} from "@officehum/sdk";
import { stringify } from "yaml";
import { manifestFromRoleSpec, parseRoleSpec, ROLE_SPEC_FILE } from "./spec.js";

/**
 * How a person answers a question. `list` is one answer per line (a blank line finishes it),
 * `choice` is one of the question's own options, and `yes-no` is a y/n answer; a blank answer to a
 * yes/no question means no, which the prompt says.
 */
export type AnswerType = "text" | "choice" | "yes-no" | "list";

/** One answer: what a person typed, chose, said yes to, or listed. */
export type Answer = string | boolean | readonly string[];

/**
 * Where one answer sits: the key it is stored under, the entry it is inside when it belongs to a
 * repeating group, and the spec path it is written to.
 */
export interface AnswerPlace {
  /** The key the answer is stored under: `role_id`, `tools[2].does`, `approvals[1].when[0].arg`. */
  readonly key: string;
  /** The key of the group entry this answer is inside; the answer's own key when it is not in one. */
  readonly entryKey: string;
  /** The key of the list an entry belongs to, for reading its other entries. */
  readonly listKey: string;
  /** The entry's index in that list; 0 when the answer is not one entry of one. */
  readonly index: number;
  /** Set when the answer is itself one entry of a group's list. */
  readonly entry?: { readonly listKey: string; readonly index: number };
  /**
   * The spec path the answer is written to. A question at a step gives the whole path (`role.id`); a
   * question inside an entry gives the field it writes there (`does`), which the walk joins to the
   * entry's own path.
   */
  readonly path: string;
}

/**
 * One question of the interview. Everything a question needs is here: the words a person reads, the
 * shape of the answer, the checks, the questions its answer calls for, and where it lands.
 */
export interface Question {
  /** The stable id of the question, and the first part of the key its answer is stored under. */
  readonly id: string;
  /**
   * Where the answer is written in the spec. A question at a step gives the whole path (`role.id`); a
   * question inside an entry gives the field it writes there (`does`), which the walk joins to the
   * entry's own path. An empty path means the entry itself, which is how a record of values —
   * `business.settings.limits` — is written.
   */
  readonly path: string;
  readonly prompt: string;
  readonly help?: string;
  readonly type: AnswerType;
  /** The options of a choice question; a function when they come from answers already given. */
  readonly choices?: readonly string[] | ((answers: Answers, at: AnswerPlace) => readonly string[]);
  /** Whether a blank answer is allowed. A blank answer to an optional question writes nothing. */
  readonly optional?: boolean;
  /** Ask this only when it applies, e.g. the engine's program only when there is an engine. */
  readonly when?: (answers: Answers, at: AnswerPlace) => boolean;
  /** Refuses an answer, in words a person reads. The interview asks the question again with it. */
  readonly validateText?: (answer: string, at: AnswerPlace, answers: Answers) => string | undefined;
  /** Refuses a whole list answer, e.g. "state at least one thing it does". */
  readonly validateList?: (
    entries: readonly string[],
    at: AnswerPlace,
    answers: Answers,
  ) => string | undefined;
  /** Refuses one entry of a list answer, e.g. a name that is not in lower_case. */
  readonly validateEntry?: (entry: string, at: AnswerPlace, answers: Answers) => string | undefined;
  /** A repeating group: the answer lists the entries, and these questions are asked for each. */
  readonly entry?: readonly Question[];
  /**
   * How a group's entries are written into the spec: `entryKeyed` is a record whose keys are the
   * entries' own text (`role.limits.long_note`), otherwise the entries are a list and `entryField`
   * names the field each entry's text is written to (`name`, `id`, `type`, `action`).
   */
  readonly entryKeyed?: boolean;
  readonly entryField?: string;
  /** Every other spec path this answer is written to, e.g. a program that also declares a runtime. */
  readonly writes?: readonly string[];
}

/** One step of the interview: what it is for, and the questions it asks. */
export interface InterviewStep {
  readonly id: string;
  readonly title: string;
  /** What the step is for, said to the person before its questions. */
  readonly intro: string;
  /** Whether the person can leave the step alone entirely, e.g. one business's own details. */
  readonly optional?: boolean;
  readonly questions: readonly Question[];
}

/** A question with an answer, as the interview asks it. */
export interface Ask {
  /** The key the answer is stored under: `role_id`, `tools[2].does`. */
  readonly id: string;
  readonly prompt: string;
  readonly help?: string;
  readonly type: AnswerType;
  readonly choices?: readonly string[];
  readonly optional?: boolean;
  /** Why this is being asked again, when an earlier answer was refused. Plain words. */
  readonly because?: string;
}

/** One question, with where its answer sits. */
export interface Asked {
  readonly question: Question;
  readonly place: AnswerPlace;
}

/** A question the person is asked again, with the problems its last answer caused. */
export interface Reask extends Asked {
  /** The problems behind this question, in the words the document's checks use. */
  readonly because: readonly string[];
}

/** The problems of a document, split by whether an answer can fix them. */
export interface Problems {
  /** The questions behind the problems, each with the problems its own answers caused. */
  readonly questions: readonly Reask[];
  /** What no answer explains: the document's own shape, reported as it stands. */
  readonly other: readonly Issue[];
}

/**
 * What every question reads: the answers given so far. Implemented over one store of answers keyed by
 * `AnswerPlace.key`, so a question, its checks and the mapping all read the same values.
 */
export interface Answers {
  /** The answer at a key, or undefined when it was never given. */
  value(key: string): Answer | undefined;
  /** The text of an answer; "" when it was not given. */
  text(key: string): string;
  /** The entries of a list answer; empty when it was not given. */
  list(key: string): readonly string[];
  /** Whether a yes/no answer is yes; a blank answer is no. */
  yes(key: string): boolean;
  /** A numeric answer, or undefined when it was blank or not a number. */
  number(key: string): number | undefined;
}

/**
 * The answers of one interview. `set` writes an answer, including one entry of a group's list, which
 * is written back into the list the entry came from — that is what re-asking a single entry means.
 */
export class AnswerStore implements Answers {
  readonly #values = new Map<string, Answer>();

  set(key: string, answer: Answer): void {
    const entry = /^(.+)\[(\d+)\]$/.exec(key);
    if (entry !== null) {
      const listKey = entry[1] ?? "";
      const index = Number(entry[2]);
      const names = this.#values.get(listKey);
      if (Array.isArray(names) && index < names.length) {
        this.#values.set(
          listKey,
          names.map((name, at) => (at === index ? String(answer) : name)),
        );
        return;
      }
    }
    this.#values.set(key, answer);
  }

  value(key: string): Answer | undefined {
    const own = this.#values.get(key);
    if (own !== undefined) return own;
    const entry = /^(.+)\[(\d+)\]$/.exec(key);
    if (entry === null) return undefined;
    const names = this.#values.get(entry[1] ?? "");
    return Array.isArray(names) ? names[Number(entry[2])] : undefined;
  }

  text(key: string): string {
    const answer = this.value(key);
    if (typeof answer === "string") return answer;
    if (typeof answer === "boolean") return answer ? "yes" : "no";
    return Array.isArray(answer) ? answer.join(", ") : "";
  }

  list(key: string): readonly string[] {
    const answer = this.value(key);
    if (Array.isArray(answer)) return answer;
    return typeof answer === "string" && answer.trim() !== "" ? [answer] : [];
  }

  yes(key: string): boolean {
    return this.value(key) === true;
  }

  number(key: string): number | undefined {
    const text = this.text(key).trim();
    if (text === "") return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }
}

/** Answers given as a plain record, for a host that builds them rather than asking for them. */
export function answersFrom(values: Readonly<Record<string, Answer>>): AnswerStore {
  const store = new AnswerStore();
  for (const [key, answer] of Object.entries(values)) store.set(key, answer);
  return store;
}

/** Lowercase words joined with dashes: the shape a role id, a skill id and a command name have. */
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Lowercase words joined with underscores: the shape a tool, parameter and limit name has. */
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** A job's name: lowercase words with dots between them, like `note.add` (`TicketType`). */
const DOTTED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]+)+$/;

/** A model, as `provider/model-id`, which the mapping splits into the spec's two fields. */
const MODEL = /^[^\s/]+\/[^\s/]+$/;

/** How a person describes what a parameter holds, and the spec type each description means. */
export const PARAMETER_TYPES: Readonly<Record<string, string>> = {
  words: "string",
  "a number": "number",
  "a whole number": "integer",
  "yes or no": "boolean",
};

/** How a person describes what waits for a person, and the spec's `enforced_by` for each. */
const HELD_BY_APPROVAL = "a person approves it first";
const HELD_BY: Readonly<Record<string, string>> = {
  [HELD_BY_APPROVAL]: "approval",
  "it has no way to do it": "no_tool",
  "only a person may do it": "person_only",
};

/** How a person describes a comparison, and the spec's `op` for each. */
const COMPARISONS: Readonly<Record<string, string>> = {
  "is more than": "gt",
  "is at least": "gte",
  "is less than": "lt",
  "is at most": "lte",
  "is exactly": "eq",
  "is not": "ne",
  "is one of a list": "in",
};

/** The comparisons that compare numbers, so their value is a number or a named limit. */
const NUMERIC_OPS = ["gt", "gte", "lt", "lte"];

/** How a person describes what makes a piece of work done, and the evidence each description means. */
const DONE_PERSON = "a person signs it off";
const DONE_TOOL = "one of the role's tools can show it";
const DONE_ENGINE = "the program can show it";
const DONE_FILE = "a file it wrote is there";

/** The yes/no answer a blank line means, said in the prompt so nobody is surprised by it. */
const BLANK_IS_NO = "(y/N)";

/** Whether the role has a program of its own; every engine question hangs off this one answer. */
const hasEngine = (answers: Answers): boolean => answers.yes("has_engine");

/** Whether the tool an entry belongs to declares a subcommand, so it works through the program. */
const toolRunsEngine = (answers: Answers, at: AnswerPlace): boolean =>
  hasEngine(answers) && answers.text(`${at.entryKey}.subcommand`) !== "";

/** Whether the tool an entry belongs to is safe to run twice. */
const toolIsSafe = (answers: Answers, at: AnswerPlace): boolean =>
  answers.yes(`${at.entryKey}.twice`);

/** Whether a wait already covers a tool, by the tool's own name. */
function approvalCovers(answers: Answers, tool: string): boolean {
  return answers
    .list("approvals")
    .some((_id, index) => answers.text(`approvals[${index}].tool`) === tool);
}

/** The role's safe tools, which are the ones a piece of work's done-ness may be shown by. */
function safeTools(answers: Answers): readonly string[] {
  return answers.list("tools").filter((_name, index) => answers.yes(`tools[${index}].twice`));
}

/** Whether the role declares any line a business could set, which the business step offers to value. */
const limitsExist = (answers: Answers): boolean => answers.list("limits").length > 0;

/** Whether the business block is being filled in at all. */
const businessWanted = (answers: Answers): boolean => answers.yes("business_wanted");

/** A refusal that names what the answer should have been. */
function wrong(what: string, got: string): string {
  return `must be ${what} (got "${got}")`;
}

/** Refuses a name that is already in the list, so two entries never collide. */
function uniqueIn(answers: Answers, at: AnswerPlace, entry: string): string | undefined {
  const clash = answers
    .list(at.listKey)
    .some((other, index) => other === entry && index !== at.index);
  return clash ? `"${entry}" is already in this list; give this one a different name` : undefined;
}

/**
 * The seven steps every role is interviewed through, plus the optional step for one business's own
 * details. Nothing in the questions belongs to a domain: every example is a placeholder for the work
 * the person in front of it does.
 */
export const INTERVIEW_STEPS: readonly InterviewStep[] = [
  {
    id: "identity",
    title: "1. Identity and mandate",
    intro:
      "First, what this role is and who it answers to. These lines go into its own instructions, which " +
      "it reads every time it works — so keep them short.",
    questions: [
      {
        id: "role_id",
        path: "role.id",
        type: "text",
        prompt:
          "What should this role be called in the office? Give it a short id: lowercase words joined " +
          "with dashes.",
        help:
          "The id is its name everywhere — on the board, in its package and in the records it writes — " +
          'so keep it short and stable: "note-keeper", not "the person who keeps our notes".',
        validateText: (answer) =>
          KEBAB.test(answer)
            ? undefined
            : wrong('lowercase words joined with dashes, like "note-keeper"', answer),
      },
      {
        id: "role_name",
        path: "role.name",
        type: "text",
        prompt: "How should it be shown to people? Give the display name.",
        help: 'The name a person sees, like "Note Keeper".',
      },
      {
        id: "department",
        path: "role.department",
        type: "choice",
        choices: [...DEPARTMENTS],
        prompt: "Which part of the business does it work in?",
        help: "The office groups roles by department, so this is the group it belongs to.",
      },
      {
        id: "role_line",
        path: "role.role",
        writes: ["context (body)"],
        type: "text",
        prompt: "In one line, what is this role for?",
        help:
          "What it does and for whom, in words a new colleague would understand — \"Keeps the team's " +
          'notes and answers questions about them".',
      },
      {
        id: "model",
        path: "role.defaultModel",
        type: "text",
        prompt: 'Which model should it think with? Give it as "provider/model".',
        help:
          'The AI model the office runs for it, for example "anthropic/claude-sonnet-5-5". A ' +
          "business can run a different one later without the role changing.",
        validateText: (answer) =>
          MODEL.test(answer)
            ? undefined
            : wrong('a provider and a model, like "anthropic/claude-sonnet-5-5"', answer),
      },
      {
        id: "channels",
        path: "role.channels",
        type: "list",
        optional: true,
        prompt:
          'Where may it speak to the business\'s customers? Answer "email", "sms" or "chat", one ' +
          "per line, and leave the line blank if it never speaks to them.",
        help: "A customer-facing role says where it may be reached; an internal one says none.",
        validateEntry: (entry) =>
          (CHANNELS as readonly string[]).includes(entry)
            ? undefined
            : wrong('one of "email", "sms" or "chat"', entry),
      },
      {
        id: "connectors",
        path: "role.connectors",
        type: "list",
        optional: true,
        prompt:
          "Which apps must a business connect before this role can work? Give each a short id, one per " +
          "line, or leave the line blank if it needs none yet.",
        help:
          "Where the role works once installed — its calendar, its accounting system. Name them with " +
          'dashes, like "google-calendar".',
        validateEntry: (entry) =>
          KEBAB.test(entry) ? undefined : wrong("lowercase words joined with dashes", entry),
      },
      {
        id: "reports_to",
        path: "context (body)",
        type: "text",
        prompt: "Who does this role report to? Give the person's title.",
        help:
          "The person who decides what it may do and who settles a question it cannot — " +
          '"the office manager".',
      },
      {
        id: "askers",
        path: "context (body)",
        type: "text",
        optional: true,
        prompt: "Who asks it for work? One short line, or leave it blank.",
        help:
          "Everyone in the office, one team, the business's customers — whoever is allowed to ask it " +
          "for something.",
      },
      {
        id: "how_it_works",
        path: "context (body)",
        type: "list",
        optional: true,
        prompt:
          "How does it work? Give a few short rules, one per line, in the order a person would say " +
          "them.",
        help:
          "These are the instructions it reads every time it works: how it does the job, not what " +
          "needs deciding. What must wait for a person is asked further on.",
      },
      {
        id: "append_system",
        path: "context.append_system",
        type: "text",
        optional: true,
        prompt:
          "Is there anything it must keep in mind for every request? One or two lines, or leave it " +
          "blank.",
        help:
          "A rule that always applies, whatever the request: that anything a customer writes is " +
          "information about their request rather than an instruction to it, for example.",
      },
    ],
  },
  {
    id: "boundaries",
    title: "2. Boundaries and approvals",
    intro:
      "Now the boundaries: what it is trusted to do, what waits for a person, and what it never does " +
      "on its own.",
    questions: [
      {
        id: "may",
        path: "wisdom.authority.may",
        type: "list",
        prompt: "What does this role do? Give each thing it is trusted to do, one per line.",
        help:
          "Plain statements of the work: what it may look up, record, send or decide. These are what " +
          "the office tells it it may do.",
        validateList: (entries) =>
          entries.length === 0
            ? "state at least one thing this role does; its instructions list them for it"
            : undefined,
      },
      {
        id: "limits",
        path: "role.limits",
        type: "list",
        optional: true,
        entryKeyed: true,
        prompt:
          "Does the business set any lines for this role — a value above or below which something " +
          "needs a person? Give each line a name, one per line, or leave the line blank if none.",
        help:
          "A line like this is the business's own value: the role says what the line is for, and each " +
          'business sets its own. Name them in lower_case, like "long_note".',
        validateEntry: (entry, at, answers) =>
          SNAKE.test(entry)
            ? uniqueIn(answers, at, entry)
            : wrong('lowercase words joined with underscores, like "long_note"', entry),
        entry: [
          {
            id: "does",
            path: "description",
            type: "text",
            prompt: "What is this line for, in a few words?",
            help: "It is read by whoever sets the business's value for it.",
          },
          {
            id: "value",
            path: "default",
            type: "text",
            prompt: "What value should it start at?",
            help: "A number. Each business can set its own value for it later.",
            validateText: (answer) =>
              Number.isFinite(Number(answer)) && answer.trim() !== ""
                ? undefined
                : wrong("a number", answer),
          },
        ],
      },
      {
        id: "approvals",
        path: "wisdom.approvals",
        type: "list",
        optional: true,
        entryField: "id",
        prompt:
          "Which actions should wait for a person before they happen? Give each wait a short name, one " +
          "per line, or leave the line blank if nothing waits.",
        help:
          "A wait is for anything it should not do on its own: money leaving, a customer being told, a " +
          'record being removed. Name them in lower_case, like "long_note".',
        validateEntry: (entry, at, answers) =>
          SNAKE.test(entry)
            ? uniqueIn(answers, at, entry)
            : wrong('lowercase words joined with underscores, like "long_note"', entry),
        entry: [
          {
            id: "tool",
            path: "tool",
            type: "text",
            prompt: "Which of its tools does this wait apply to? Give the tool's name.",
            help:
              "The name you gave that tool in the list you just gave. If it is not a tool yet, list the " +
              "tool first and give its name here.",
          },
          {
            id: "does",
            path: "description",
            type: "text",
            prompt: "What is the wait for, in a few words a person would read?",
            help: 'It is shown to whoever decides: "Notes longer than the business\'s line".',
          },
          {
            id: "always",
            path: "when",
            type: "choice",
            choices: ["every time the tool runs", "only if a value passes a line"],
            prompt: "Should every run of that tool wait, or only some?",
            help:
              "Every run for anything unvarying — sending an invoice, paying a bill. Only some for a " +
              "tool in daily use, where a large value needs a person.",
          },
          {
            id: "arg",
            path: "when[0].arg",
            type: "text",
            when: (answers, at) =>
              answers.text(`${at.entryKey}.always`) !== "every time the tool runs",
            prompt: "Which value does the wait look at? Give the tool's parameter by name.",
            help:
              "The parameter the tool is given — the amount, the quantity, how long the text is. The " +
              "role compares it to the line and waits if it passes.",
          },
          {
            id: "compare",
            path: "when[0].op",
            type: "choice",
            choices: Object.keys(COMPARISONS),
            when: (answers, at) =>
              answers.text(`${at.entryKey}.always`) !== "every time the tool runs",
            prompt: "How is that value compared to the line?",
            help: "Choose the one a person would say out loud: more than, at most, exactly, one of a list.",
          },
          {
            id: "value",
            path: "when[0].value",
            type: "text",
            when: (answers, at) =>
              answers.text(`${at.entryKey}.always`) !== "every time the tool runs" &&
              answers.text(`${at.entryKey}.compare`) !== "is one of a list",
            prompt:
              "What is the value compared to? Give a number, or the name of one of the lines you named " +
              "above.",
            help:
              "A number the wait uses as it stands, or one of the business's own lines — a wait on a " +
              "line uses each business's own value for it.",
          },
          {
            id: "values",
            path: "when[0].value",
            type: "list",
            when: (answers, at) => answers.text(`${at.entryKey}.compare`) === "is one of a list",
            prompt: "Which values are allowed? Give them one per line.",
            help: "The wait applies if the value is one of these; anything else goes ahead.",
          },
        ],
      },
      {
        id: "may_not",
        path: "wisdom.authority.may_not",
        type: "list",
        entryField: "action",
        prompt: "What should this role never do? Give each thing, one per line.",
        help:
          "What it must not do however it is asked: acting on a record another agent is working on, " +
          "rewriting something already written, telling a customer something nobody confirmed.",
        validateList: (entries) =>
          entries.length === 0
            ? "state at least one thing this role never does, and what it does instead"
            : undefined,
        validateEntry: (entry, at, answers) => uniqueIn(answers, at, entry),
        entry: [
          {
            id: "instead",
            path: "instead",
            type: "text",
            prompt: "When it is asked to do that, what should it do instead?",
            help:
              "Where the request should go: ask the person who asked to decide, ask another role's " +
              "owner, add a record that replaces the old one.",
          },
          {
            id: "held_by",
            path: "enforced_by",
            type: "choice",
            choices: (answers) =>
              answers.list("approvals").length === 0
                ? Object.keys(HELD_BY).filter((option) => option !== HELD_BY_APPROVAL)
                : Object.keys(HELD_BY),
            prompt: "How is it held to that?",
            help:
              "The office enforces it in one of these ways, so pick the true one: a wait, no tool that " +
              "could do it, or a person only.",
          },
          {
            id: "approval",
            path: "enforced_by",
            type: "choice",
            when: (answers, at) => answers.text(`${at.entryKey}.held_by`) === HELD_BY_APPROVAL,
            choices: (answers) => answers.list("approvals"),
            prompt: "Which wait covers it?",
            help: "The wait that stops it: it is refused unless a person says yes.",
          },
        ],
      },
    ],
  },
  {
    id: "tools",
    title: "3. Its program and its tools",
    intro:
      "Now the work itself: whether the role has a program of its own to get facts and figures from, " +
      "and the tools it works through.",
    questions: [
      {
        id: "has_engine",
        path: "role.engine",
        type: "yes-no",
        prompt:
          "Does this role work from a program of its own — one the host runs to get its facts and " +
          `figures? ${BLANK_IS_NO}`,
        help:
          "A program like this is what it counts with: it answers from the business's own records " +
          "rather than working a figure out. Answer no if it works only through the apps it can call.",
      },
      {
        id: "engine_program",
        path: "role.engine.command[0]",
        writes: ["role.runtimes[0].name"],
        type: "text",
        when: hasEngine,
        prompt: "Which program does the host run? Give the program's name.",
        help: 'The program itself, as a shell would name it — "python3", or "node".',
        validateText: (answer) =>
          /^[a-z][a-z0-9._+-]*$/.test(answer)
            ? undefined
            : wrong('a program name, like "python3"', answer),
      },
      {
        id: "engine_version",
        path: "role.runtimes[0].version",
        type: "text",
        when: hasEngine,
        prompt: "What version of it should the host provide? Give a range.",
        help:
          'A range the host checks against the program it has, like ">=3.10": it means that version or ' +
          "anything newer.",
        validateText: (answer) =>
          /^[<>=^~]*\s*\d+(\.\d+)*\s*$/.test(answer)
            ? undefined
            : wrong('a version range, like ">=3.10"', answer),
      },
      {
        id: "engine_script",
        path: "role.engine.command[1]",
        type: "text",
        when: hasEngine,
        prompt:
          "What does the host pass to it? Give the script or file that lives inside the role's own " +
          "package.",
        help: 'For example "engine/engine.py": it stays the same wherever the role is installed.',
      },
      {
        id: "engine_does",
        path: "role.engine.description",
        type: "text",
        optional: true,
        when: hasEngine,
        prompt: "In a few words, what is the program for?",
        help: "One line about it, for whoever installs the role.",
      },
      {
        id: "tools",
        path: "role.tools",
        type: "list",
        optional: true,
        entryField: "name",
        prompt:
          "Which tools does this role work through? Give each a name, one per line, or leave the line " +
          "blank if it only answers from what it is told.",
        help:
          "A tool is one thing it can do with the business's own systems: look something up, record " +
          'something, tell someone. Name them in lower_case, like "search_notes".',
        validateEntry: (entry, at, answers) => {
          if (!SNAKE.test(entry)) {
            return wrong('lowercase words joined with underscores, like "search_notes"', entry);
          }
          // The names a role may not take, from the SDK's own lists, so the rule heard here is the
          // rule the manifest enforces rather than a copy of it that could drift.
          const generic = GENERIC_TOOLS[entry];
          if (generic !== undefined) {
            return `"${entry}" is a ${generic}, and every host already has one; name the thing this role does to the business's own systems instead`;
          }
          if ((RESERVED_TOOL_NAMES as readonly string[]).includes(entry)) {
            return `"${entry}" is one of the office's own tools; give this one a different name`;
          }
          return uniqueIn(answers, at, entry);
        },
        entry: [
          {
            id: "does",
            path: "does",
            type: "text",
            prompt: "What does it do, in one or two sentences?",
            help:
              "This is what the model reads about the tool, so say what it does with what, and what " +
              "comes back.",
          },
          {
            id: "subcommand",
            path: "engine[0]",
            type: "text",
            optional: true,
            when: hasEngine,
            prompt:
              "What does the program do for this tool? Give the words it passes to the program, like " +
              '"search", or leave the line blank if this tool is a piece of code rather than part of ' +
              "the program.",
            help:
              "A tool that runs through the program is built from this declaration; a tool that is not " +
              "yet written needs code added to the package later.",
          },
          {
            id: "twice",
            path: "replay",
            type: "yes-no",
            prompt: `Is it safe to run this tool twice by mistake? ${BLANK_IS_NO}`,
            help:
              "Yes for looking something up. No for anything that records, sends or tells someone: " +
              "running that twice would do it twice.",
          },
          {
            id: "parameters",
            path: "parameters",
            type: "list",
            optional: true,
            entryKeyed: true,
            when: toolRunsEngine,
            prompt:
              "What does it need to be told? Give each thing a name, one per line, or leave the line " +
              "blank if it needs nothing.",
            help: 'Name them in lower_case, like "text" or "period".',
            validateEntry: (entry, at, answers) =>
              SNAKE.test(entry)
                ? uniqueIn(answers, at, entry)
                : wrong('lowercase words joined with underscores, like "text"', entry),
            entry: [
              {
                id: "type",
                path: "type",
                type: "choice",
                choices: Object.keys(PARAMETER_TYPES),
                prompt: "What does it hold?",
                help:
                  "Words for text, a number for a value with a decimal in it, a whole number for a " +
                  "count, yes or no for a switch.",
              },
              {
                id: "does",
                path: "description",
                type: "text",
                prompt: "What is it, in a few words?",
                help: "The hint the model is given about it.",
              },
            ],
          },
          {
            id: "guidelines",
            path: "guidelines",
            type: "list",
            optional: true,
            prompt:
              "Is there anything it should remember while using this tool? One rule per line, or leave " +
              "the line blank.",
            help: 'Short rules about using it well, like "say the record\'s id back to whoever asked".',
          },
          {
            id: "no_approval",
            // The declaration as a whole: the parser reports a tool whose approval decision is missing
            // there rather than at a field, and the schema's own report of it sits under this path.
            path: "",
            type: "text",
            when: (answers, at) =>
              !toolIsSafe(answers, at) && !approvalCovers(answers, answers.text(at.entryKey)),
            prompt:
              "Nothing waits for a person on this one, and it is not safe to run twice. Why is that " +
              "all right?",
            help:
              "Say in a few words why it needs nobody — \"an internal move inside the role's own " +
              'store; nothing outside it changes". If it should wait for a person instead, add a wait ' +
              "that names this tool.",
          },
        ],
      },
    ],
  },
  {
    id: "handoffs",
    title: "4. Work that arrives, and work that is not its own",
    intro: "Now what comes in and what goes elsewhere.",
    questions: [
      {
        id: "accepts",
        path: "workflow.accepts",
        type: "list",
        optional: true,
        entryField: "type",
        prompt:
          "What work arrives for this role to pick up? Give each kind a name, one per line, or leave " +
          "the line blank if it only answers the questions people ask it.",
        help:
          "Work that arrives as a job of its own, named the office's way: lowercase words with dots " +
          'between them, like "note.add".',
        validateEntry: (entry, at, answers) =>
          DOTTED.test(entry)
            ? uniqueIn(answers, at, entry)
            : wrong('lowercase words with a dot between them, like "note.add"', entry),
        entry: [
          {
            id: "does",
            path: "description",
            type: "text",
            prompt: "What is one of these, in a line?",
            help: "What arrives and what the role is being asked for.",
          },
          {
            id: "done",
            path: "done",
            type: "choice",
            choices: (answers) => {
              const kinds = [DONE_PERSON, DONE_FILE];
              if (safeTools(answers).length > 0) kinds.push(DONE_TOOL);
              if (hasEngine(answers)) kinds.push(DONE_ENGINE);
              return kinds;
            },
            prompt: "How does the office know one of them is done?",
            help: "Whoever hands the work over is shown this, so pick the one that actually settles it.",
          },
          {
            id: "done_tool",
            path: "done[0].tool",
            type: "choice",
            when: (answers, at) => answers.text(`${at.entryKey}.done`) === DONE_TOOL,
            choices: safeTools,
            prompt: "Which tool shows it is done?",
            help: "Only the role's safe tools, because the host runs this itself rather than the model.",
          },
          {
            id: "done_engine",
            path: "done[0].engine",
            type: "text",
            when: (answers, at) => answers.text(`${at.entryKey}.done`) === DONE_ENGINE,
            prompt:
              "What does the program run to show it is done? Give the words, or leave it blank.",
            help: 'For example "levels": it is expected to answer with what the work had to change.',
          },
          {
            id: "done_file",
            path: "done[0].file",
            type: "text",
            when: (answers, at) => answers.text(`${at.entryKey}.done`) === DONE_FILE,
            prompt: "Which file must be there once it is done?",
            help: "The name of the file it writes for this kind of work.",
          },
        ],
      },
      {
        id: "hands_off",
        path: "context (body)",
        type: "list",
        optional: true,
        prompt:
          "What work is not this role's, and should go to somebody else? Give each one, one per line, " +
          "or leave the line blank if it takes on everything it is asked.",
        help:
          "Work it should hand over rather than take on. These are written into its own instructions " +
          "so it says who takes them on instead.",
      },
    ],
  },
  {
    id: "skills",
    title: "5. Procedures",
    intro:
      "Now the procedures: anything you would write down for someone new, so the role follows it too.",
    questions: [
      {
        id: "skills",
        path: "knowledge.skills",
        type: "list",
        optional: true,
        entryField: "id",
        prompt:
          "Are there procedures this role should follow? Give each a short name, one per line, or " +
          "leave the line blank if there are none.",
        help:
          "Each one becomes a page it reads as it needs to. Name them with dashes, like " +
          '"note-house-style".',
        validateEntry: (entry, at, answers) =>
          KEBAB.test(entry)
            ? uniqueIn(answers, at, entry)
            : wrong('lowercase words joined with dashes, like "note-house-style"', entry),
        entry: [
          {
            id: "use",
            path: "description",
            type: "text",
            prompt:
              "In one sentence: what does it cover, and at what point should the role read it?",
            help:
              "The office shows this while the role is deciding what to do, so name the moment it " +
              'applies — "How to write the notes this role keeps. Read it before writing or quoting a ' +
              'note."',
          },
          {
            id: "steps",
            path: "instructions",
            type: "list",
            prompt: "What are the steps? One per line.",
            help: "The procedure in your own words, in the order it is done.",
            validateList: (entries) =>
              entries.length === 0
                ? "write at least one step; a procedure is what it should do"
                : undefined,
          },
          {
            id: "default",
            path: "enabled_by_default",
            type: "choice",
            choices: ["read it from the start", "leave it until a business turns it on"],
            prompt: "Should the role read it from the start, or only if a business turns it on?",
            help: "From the start for a procedure it should follow unless it is turned off.",
          },
        ],
      },
    ],
  },
  {
    id: "commands",
    title: "6. Views for whoever runs the office",
    intro: "Now the quick views, if any, for the person running the office.",
    questions: [
      {
        id: "commands",
        path: "workflow.commands",
        type: "list",
        optional: true,
        entryField: "name",
        when: hasEngine,
        prompt:
          "Should a person be able to run anything from this role's own program without asking the " +
          "model — a view or a report? Give each a name, one per line, or leave the line blank.",
        help:
          "For whoever runs the office: a quick look at what the role works from. Name them with " +
          'dashes, like "list-notes".',
        validateEntry: (entry, at, answers) =>
          KEBAB.test(entry)
            ? uniqueIn(answers, at, entry)
            : wrong('lowercase words joined with dashes, like "list-notes"', entry),
        entry: [
          {
            id: "does",
            path: "description",
            type: "text",
            prompt: "What does the view show?",
            help: "A line a person reads before running it.",
          },
          {
            id: "run",
            path: "engine",
            type: "text",
            prompt: "What does it run? Give the words the program is given.",
            help: 'For example "list" or "levels --summary".',
          },
        ],
      },
    ],
  },
  {
    id: "situations",
    title: "7. Situations to try it on",
    intro:
      "Last, a few situations the office should see it handle. Each one becomes a test the role is run " +
      "against, so pick the ordinary case and the awkward ones.",
    questions: [
      {
        id: "situations",
        path: "evals",
        type: "list",
        entryField: "id",
        prompt:
          "Give three to five situations, one per line: each a short name for something a person " +
          "might say or send.",
        help:
          'A name of a situation, not the request itself — "a short note is added", "a long note waits ' +
          'for a person", "a note is quoted back".',
        validateList: (entries, _at, _answers) =>
          entries.length < 3
            ? `give at least three situations (got ${entries.length}); a role is judged on the ones it is tried on`
            : entries.length > 5
              ? `give at most five situations (got ${entries.length}); the rest belong in the role's own evals`
              : undefined,
        validateEntry: (entry, at, answers) => {
          const slugged = slug(entry, "");
          if (slugged === "") return "give each situation a name with a letter or a number in it";
          if (slugged.length > 80) return "give a shorter name; it becomes the test's own id";
          const clash = answers
            .list(at.listKey)
            .some((other, index) => index !== at.index && slug(other, "") === slugged);
          return clash
            ? `"${entry}" is another situation with the same name; make it different`
            : undefined;
        },
        entry: [
          {
            id: "ask",
            path: "input.text",
            type: "text",
            prompt: "What does the person say or send? Write it the way they would say it.",
            help: "The words that arrive, in one line.",
          },
          {
            id: "does",
            path: "description",
            type: "text",
            prompt: "What should the role do about it? One line.",
            help: "What a good answer looks like, for whoever reads the test later.",
          },
          {
            id: "calls",
            path: "expect.calls",
            type: "list",
            optional: true,
            prompt:
              "Which of its tools should it use for this? Give their names, one per line, or leave the " +
              "line blank if none.",
            help: "The tools the test expects it to reach for.",
            validateEntry: (entry, _at, answers) =>
              answers.list("tools").includes(entry)
                ? undefined
                : `"${entry}" is not one of the role's tools; give one of theirs or leave the line blank`,
          },
          {
            id: "never",
            path: "expect.notCalled",
            type: "list",
            optional: true,
            prompt:
              "What must never happen here? Name any tool that must not run, one per line, or leave " +
              "the line blank.",
            help:
              "The part that must not slip: a record that must not be written, a customer who must " +
              "not be told.",
            validateEntry: (entry, _at, answers) =>
              answers.list("tools").includes(entry)
                ? undefined
                : `"${entry}" is not one of the role's tools; give one of theirs or leave the line blank`,
          },
          {
            id: "critical",
            path: "severity",
            type: "choice",
            choices: ["it must hold every time", "it should hold, but a slip is not fatal"],
            prompt: "How strict is this one?",
            help:
              "Strict for the ones that must not slip — anything about a person's money, a customer or " +
              "a record that cannot be undone.",
          },
        ],
      },
    ],
  },
];

/** The one step that belongs to a single business rather than to the role. */
export const BUSINESS_STEP: InterviewStep = {
  id: "business",
  title: "8. One business's own details (optional)",
  intro:
    "The role itself is now complete, and it is the same one every business installs. If you are " +
    "building it for one business, its own details go beside the package rather than into it.",
  optional: true,
  questions: [
    {
      id: "business_wanted",
      path: "business",
      type: "yes-no",
      optional: true,
      prompt: `Do you want to fill in one business's own details now? ${BLANK_IS_NO}`,
      help:
        "The role's name, its ways of working and its own values for the lines you set belong to the " +
        "business, so they are written beside the role and never into it. Leave this blank if anyone " +
        "may install the role.",
    },
    {
      id: "business_name",
      path: "business.name",
      type: "text",
      when: businessWanted,
      prompt: "What is the business called?",
      help: "The name it goes by in the office.",
    },
    {
      id: "business_context",
      path: "business.agents_md",
      type: "text",
      optional: true,
      when: businessWanted,
      prompt:
        "Is there anything this business adds to the role's own instructions? A short paragraph, or " +
        "leave it blank.",
      help:
        "Its own vocabulary, or a house rule that is theirs rather than the role's. The role itself " +
        "carries none of it.",
    },
    {
      id: "business_limits",
      path: "business.settings.limits",
      type: "list",
      optional: true,
      entryKeyed: true,
      when: (answers) => businessWanted(answers) && limitsExist(answers),
      prompt:
        "Do you want to give any of the lines you named earlier this business's own value? Give each " +
        "line, one per line, or leave the line blank if the values you gave are the ones it wants.",
      help: "Each business sets its own value for a line; this one is written into its own settings.",
      validateEntry: (entry, at, answers) =>
        answers.list("limits").includes(entry)
          ? uniqueIn(answers, at, entry)
          : `"${entry}" is not one of the lines you named; give one of them, or leave the line blank`,
      entry: [
        {
          id: "value",
          path: "",
          type: "text",
          prompt: "What value should this business set for it?",
          help: "A number. It replaces the value the role itself declares.",
          validateText: (answer) =>
            Number.isFinite(Number(answer)) && answer.trim() !== ""
              ? undefined
              : wrong("a number", answer),
        },
      ],
    },
  ],
};

/** Every step, in the order the interview asks them. */
export const STEPS: readonly InterviewStep[] = [...INTERVIEW_STEPS, BUSINESS_STEP];

/** A kebab-case id from a person's own words; "" when the words hold no letter or digit. */
export function slug(text: string, fallback: string): string {
  const slugged = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slugged === "" ? fallback : slugged;
}

/** What one entry of a group is written to: the container its answers are fields of, and the path the
 * entry's own text lands at when the group names one. */
function entryPaths(
  question: Question,
  at: AnswerPlace,
  index: number,
  entry: string,
): { readonly container: string; readonly path: string } {
  if (question.entryKeyed === true) {
    const container = `${at.path}.${entry}`;
    return { container, path: container };
  }
  const container = `${at.path}[${index}]`;
  const field = question.entryField;
  return { container, path: field === undefined ? container : `${container}.${field}` };
}

/** The place a question sits at before anything is known about its answers. */
function rootPlace(question: Question): AnswerPlace {
  return {
    key: question.id,
    entryKey: question.id,
    listKey: question.id,
    index: 0,
    path: question.path,
  };
}

/**
 * Every question the answers call for, in the order the interview asks them, with the place each
 * answer sits at.
 *
 * A generator, because the questions a group asks depend on the answer its list is given: the walk
 * pauses at each question, the interviewer asks it and stores the answer, and the walk's next step
 * reads the answers as they now stand. That is what lets the same function answer "what was asked?"
 * (`asksFor`) and ask it.
 */
export function* questionsOf(answers: Answers): Generator<Asked, void, void> {
  for (const step of STEPS) yield* questionsOfStep(step, answers);
}

/** Every question one step asks, walking the answers as it goes. */
export function* questionsOfStep(
  step: InterviewStep,
  answers: Answers,
): Generator<Asked, void, void> {
  for (const question of step.questions) {
    yield* walkQuestion(question, rootPlace(question), answers);
  }
}

function* walkQuestion(
  question: Question,
  at: AnswerPlace,
  answers: Answers,
): Generator<Asked, void, void> {
  if (!applies(question, answers, at)) return;
  yield { question, place: at };
  if (question.entry === undefined) return;
  const entries = answers.list(at.key);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    const paths = entryPaths(question, at, index, entry);
    const entryPlace: AnswerPlace = {
      key: `${at.key}[${index}]`,
      entryKey: `${at.key}[${index}]`,
      listKey: at.key,
      index,
      entry: { listKey: at.key, index },
      path: paths.path,
    };
    yield { question, place: entryPlace };
    for (const child of question.entry) {
      yield* walkQuestion(
        child,
        {
          key: `${at.key}[${index}].${child.id}`,
          entryKey: entryPlace.key,
          listKey: at.key,
          index,
          path: child.path === "" ? paths.container : `${paths.container}.${child.path}`,
        },
        answers,
      );
    }
  }
}

/** Whether a question applies to the answers given so far. */
export function applies(question: Question, answers: Answers, at: AnswerPlace): boolean {
  return question.when === undefined || question.when(answers, at);
}

/** Every question the answers call for, with the place each answer sits at. */
export function asksFor(answers: Answers): readonly Asked[] {
  return [...questionsOf(answers)];
}

/** The choices a choice question offers now, which some of them take from answers already given. */
export function choicesFor(
  question: Question,
  answers: Answers,
  at: AnswerPlace,
): readonly string[] {
  const choices = question.choices;
  if (choices === undefined) return [];
  return typeof choices === "function" ? choices(answers, at) : choices;
}

/** The question as the interviewer asks it: the words, and the reason when it is a second asking. */
export function askOf(asked: Asked, answers: Answers, because: readonly string[] | undefined): Ask {
  const { question, place } = asked;
  const choices = choicesFor(question, answers, place);
  const reason = because === undefined || because.length === 0 ? undefined : because.join("; ");
  return {
    id: place.key,
    prompt: question.prompt,
    ...(question.help === undefined ? {} : { help: question.help }),
    type: question.type,
    ...(choices.length === 0 ? {} : { choices }),
    ...(question.optional === true ? { optional: true } : {}),
    ...(reason === undefined ? {} : { because: reason }),
  };
}

/**
 * The problem with an answer as it stands, or undefined when it stands. A blank answer to a required
 * question is a problem; to an optional one it writes nothing, which is an answer of its own.
 */
export function problemWith(asked: Asked, answers: Answers): string | undefined {
  const { question, place } = asked;
  const value = answers.value(place.key);
  // Nothing has been answered yet: whether the question is asked at all is the interviewer's business,
  // and a required question left blank is a problem once it has been answered blank.
  if (value === undefined) return undefined;
  // An entry of a group's list: its text is one entry rather than the list's answer, so the group's
  // check for a single entry is the one that applies.
  if (place.entry !== undefined) {
    return typeof value === "string" && value.trim() !== ""
      ? question.validateEntry?.(value, place, answers)
      : "this is needed to write the role";
  }
  const blank =
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0);
  if (blank) {
    return question.optional === true ? undefined : "this is needed to write the role";
  }

  switch (question.type) {
    case "yes-no":
      return typeof value === "boolean"
        ? undefined
        : `must be answered "yes" or "no" (got "${String(value)}")`;
    case "choice": {
      const choices = choicesFor(question, answers, place);
      if (typeof value === "string" && choices.includes(value)) return undefined;
      return choices.length === 0
        ? "there is nothing to choose from yet: answer the question it comes from first"
        : `must be one of ${choices.map((choice) => `"${choice}"`).join(", ")} (got "${String(value)}")`;
    }
    case "text":
      return typeof value === "string"
        ? question.validateText?.(value, place, answers)
        : `must be text (got "${String(value)}")`;
    case "list": {
      if (!Array.isArray(value)) return `must be a list of lines (got "${String(value)}")`;
      if (place.entry !== undefined) {
        return question.validateEntry?.(answers.text(place.key), place, answers);
      }
      return question.validateList?.(value, place, answers);
    }
  }
}

/** The frontmatter and the body of the one document the interview writes. */
export interface SpecDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/**
 * The document, as the interview writes it: frontmatter through the YAML dumper, then the role's own
 * context. Every answer that lives in the frontmatter is dumped rather than placed, because a person's
 * answer holds colons, quotes, newlines and emoji, and a hand-built block of YAML is how a generated
 * spec becomes unparseable.
 *
 * The body is written as itself rather than dumped: `parseRoleSpec` reads the body verbatim and the
 * generator writes that text into `AGENTS.md`, so a dumped body would put the block scalar's `|` and
 * its indentation into the prompt the model reads every turn. It is markdown built from answers, and
 * markdown needs no escaping.
 */
export function specDocument(answers: Answers): string {
  const document = specFromAnswers(answers);
  return `---\n${stringify(document.frontmatter, { lineWidth: 0 })}---\n${document.body}\n`;
}

/** The frontmatter and body of the spec the answers describe. */
export function specFromAnswers(answers: Answers): SpecDocument {
  const engine = engineFrom(answers);
  const limits = limitsFrom(answers);
  const appendSystem = answers.text("append_system").trim();
  const commands = commandsFrom(answers);
  const business = businessFrom(answers);
  const frontmatter: Record<string, unknown> = {
    schema: 1,
    role: {
      id: answers.text("role_id"),
      name: answers.text("role_name"),
      department: answers.text("department"),
      role: answers.text("role_line"),
      defaultModel: modelFrom(answers),
      ...(engine === undefined
        ? {}
        : {
            runtimes: [engine.runtime],
            engine: {
              command: engine.command,
              ...(engine.description === "" ? {} : { description: engine.description }),
            },
          }),
      tools: toolsFrom(answers),
      connectors: answers.list("connectors"),
      channels: answers.list("channels"),
      ...(limits === undefined ? {} : { limits }),
    },
    ...(appendSystem === "" ? {} : { context: { append_system: appendSystem } }),
    knowledge: { skills: skillsFrom(answers) },
    wisdom: {
      approvals: approvalsFrom(answers),
      authority: { may: answers.list("may"), may_not: mayNotsFrom(answers) },
    },
    workflow: {
      accepts: acceptsFrom(answers),
      ...(commands.length === 0 ? {} : { commands }),
    },
    evals: situationsFrom(answers),
    ...(business === undefined ? {} : { business }),
  };
  return { frontmatter, body: bodyFrom(answers) };
}

/** `provider/model`, as the spec's two fields. */
function modelFrom(answers: Answers): Record<string, unknown> {
  const [provider = "", ...rest] = answers.text("model").split("/");
  return { provider, modelId: rest.join("/") };
}

/** The role's program, its runtime and the command a host runs. */
function engineFrom(answers: Answers):
  | {
      readonly runtime: Record<string, unknown>;
      readonly command: string[];
      readonly description: string;
    }
  | undefined {
  if (!answers.yes("has_engine")) return undefined;
  const program = answers.text("engine_program");
  const script = answers.text("engine_script").trim();
  return {
    runtime: { name: program, version: answers.text("engine_version") },
    command: script === "" ? [program] : [program, script],
    description: answers.text("engine_does").trim(),
  };
}

/** The lines the business sets: each one's description and the value it starts at. */
function limitsFrom(answers: Answers): Record<string, unknown> | undefined {
  const names = answers.list("limits");
  if (names.length === 0) return undefined;
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      {
        description: answers.text(`limits[${index}].does`),
        default: answers.number(`limits[${index}].value`) ?? 0,
      },
    ]),
  );
}

/** The role's tools: a tool that runs through the program, or one whose code comes later. */
function toolsFrom(answers: Answers): Record<string, unknown>[] {
  return answers.list("tools").map((name, index) => {
    const at = `tools[${index}]`;
    const subcommand = answers.text(`${at}.subcommand`).trim();
    const unsafe = !answers.yes(`${at}.twice`);
    // What one answer writes only where its question still applies: a tool that runs through the
    // program is the only one that may declare parameters, and an unsafe tool that no wait covers is
    // the only one that may say why it needs none. An answer given before a later one moved the ground
    // under it is left out rather than written into a declaration the parser refuses.
    const parameters = subcommand === "" ? undefined : parametersFrom(answers, at);
    const guidelines = answers.list(`${at}.guidelines`);
    const note = answers.text(`${at}.no_approval`).trim();
    return {
      name,
      replay: unsafe ? "unsafe" : "safe",
      ...(subcommand === "" ? {} : { engine: [subcommand] }),
      description: answers.text(`${at}.does`),
      ...(parameters === undefined ? {} : { parameters }),
      ...(guidelines.length === 0 ? {} : { guidelines }),
      ...(note === "" || !unsafe || approvalCovers(answers, name) ? {} : { noApproval: note }),
    };
  });
}

/** The parameters a tool is given, keyed by name: only an engine tool may declare them. */
function parametersFrom(answers: Answers, at: string): Record<string, unknown> | undefined {
  const names = answers.list(`${at}.parameters`);
  if (names.length === 0) return undefined;
  return Object.fromEntries(
    names.map((name, index) => {
      const key = `${at}.parameters[${index}]`;
      return [
        name,
        {
          type: PARAMETER_TYPES[answers.text(`${key}.type`)] ?? "string",
          description: answers.text(`${key}.does`),
        },
      ];
    }),
  );
}

/** What waits for a person: the tool, and the condition when the wait is not on every run. */
function approvalsFrom(answers: Answers): Record<string, unknown>[] {
  return answers.list("approvals").map((id, index) => {
    const at = `approvals[${index}]`;
    const everyRun = answers.text(`${at}.always`) === "every time the tool runs";
    return {
      id,
      tool: answers.text(`${at}.tool`),
      description: answers.text(`${at}.does`),
      ...(everyRun ? {} : { when: [conditionFrom(answers, at)] }),
    };
  });
}

/** One condition: the argument, the comparison, and the value or the line it compares to. */
function conditionFrom(answers: Answers, at: string): Record<string, unknown> {
  const comparison = answers.text(`${at}.compare`);
  const op = COMPARISONS[comparison] ?? "eq";
  const named = answers.text(`${at}.value`).trim();
  const value =
    op === "in"
      ? answers.list(`${at}.values`)
      : answers.list("limits").includes(named)
        ? { limit: named }
        : (answers.number(`${at}.value`) ?? named);
  return { arg: answers.text(`${at}.arg`).trim(), op, value };
}

/** What the role never does: the action, what it does instead, and how that is enforced. */
function mayNotsFrom(answers: Answers): Record<string, unknown>[] {
  return answers.list("may_not").map((action, index) => {
    const at = `may_not[${index}]`;
    const held = answers.text(`${at}.held_by`);
    const enforced =
      held === HELD_BY_APPROVAL
        ? `approval:${answers.text(`${at}.approval`)}`
        : (HELD_BY[held] ?? "no_tool");
    return { action, instead: answers.text(`${at}.instead`), enforced_by: enforced };
  });
}

/** One entry of a piece of work's completion evidence, from how the person said it is settled. */
function evidenceFrom(answers: Answers, at: string): Record<string, unknown> {
  const kind = answers.text(`${at}.done`);
  if (kind === DONE_TOOL) return { tool: answers.text(`${at}.done_tool`), expect: "found" };
  if (kind === DONE_ENGINE) {
    const words = answers.text(`${at}.done_engine`).trim().split(/\s+/).filter(Boolean);
    return words.length === 0 ? { person: true } : { engine: words };
  }
  if (kind === DONE_FILE) return { file: answers.text(`${at}.done_file`).trim() };
  return { person: true };
}

/** Work that arrives, with what settles one of them. */
function acceptsFrom(answers: Answers): Record<string, unknown>[] {
  return answers.list("accepts").map((type, index) => {
    const at = `accepts[${index}]`;
    return {
      type,
      description: answers.text(`${at}.does`),
      done: [evidenceFrom(answers, at)],
    };
  });
}

/** The procedures the role follows, each a page it reads when it needs to. */
function skillsFrom(answers: Answers): Record<string, unknown>[] {
  return answers.list("skills").map((id, index) => {
    const at = `skills[${index}]`;
    const steps = answers.list(`${at}.steps`);
    return {
      id,
      description: answers.text(`${at}.use`),
      enabled_by_default: answers.text(`${at}.default`) === "read it from the start",
      instructions: steps.map((step, number) => `${number + 1}. ${step}`).join("\n"),
    };
  });
}

/** Views for whoever runs the office: they run the program, without the model. */
function commandsFrom(answers: Answers): Record<string, unknown>[] {
  // A view is a way to run the role's program, so a role without one has none: an answer given before
  // the program was dropped is left out rather than written as a command nothing can run.
  if (!answers.yes("has_engine")) return [];
  return answers.list("commands").map((name, index) => {
    const at = `commands[${index}]`;
    const words = answers.text(`${at}.run`).trim().split(/\s+/).filter(Boolean);
    return { name, description: answers.text(`${at}.does`), engine: words };
  });
}

/**
 * The situations the role is tried on: one scenario each, every tool stubbed so no test can reach a
 * real system, and the answer's own name made into the scenario's id.
 */
function situationsFrom(answers: Answers): Record<string, unknown>[] {
  return answers.list("situations").map((name, index) => {
    const at = `situations[${index}]`;
    const calls = answers.list(`${at}.calls`).map((tool) => ({ tool }));
    const notCalled = answers.list(`${at}.never`);
    // A scenario's stubs are its own objects rather than one shared map: the dumper would write a
    // YAML anchor and alias for a shared one, and a spec a person reviews reads better without them.
    const stubs = Object.fromEntries(
      answers.list("tools").map((tool) => [tool, { text: `${tool}: ran in this evaluation` }]),
    );
    return {
      id: slug(name, `situation-${index + 1}`),
      description: answers.text(`${at}.does`),
      ...(answers.text(`${at}.critical`) === "it must hold every time"
        ? { severity: "critical" }
        : {}),
      input: { kind: "message", text: answers.text(`${at}.ask`) },
      stubs,
      expect: {
        ...(calls.length === 0 ? {} : { calls }),
        ...(notCalled.length === 0 ? {} : { notCalled }),
      },
    };
  });
}

/** One business's own details, written beside the package rather than into it. */
function businessFrom(answers: Answers): Record<string, unknown> | undefined {
  if (!answers.yes("business_wanted")) return undefined;
  const context = answers.text("business_context").trim();
  const values = businessLimitsFrom(answers);
  return {
    name: answers.text("business_name"),
    ...(context === "" ? {} : { agents_md: context }),
    ...(values === undefined ? {} : { settings: { limits: values } }),
  };
}

/** The values one business sets for the role's lines. */
function businessLimitsFrom(answers: Answers): Record<string, number> | undefined {
  const names = answers.list("business_limits");
  if (names.length === 0) return undefined;
  return Object.fromEntries(
    names.map((name, index) => [name, answers.number(`business_limits[${index}].value`) ?? 0]),
  );
}

/**
 * The role's own context: the markdown the generator writes as `AGENTS.md`, before the sections it
 * adds itself. It holds what the role is told every time it works, and no numbers: a value belongs in
 * a wait, in a business's own settings, or in a procedure.
 */
function bodyFrom(answers: Answers): string {
  const name = answers.text("role_name").trim();
  const line = answers.text("role_line").trim();
  const reportsTo = answers.text("reports_to").trim();
  const askers = answers.text("askers").trim();
  const lines: string[] = [`# ${name}`, "", `${line}.`, "", "## Who you are", ""];
  lines.push(
    `You are this office's ${answers.text("department")} role. You report to ${reportsTo}, who decides ` +
      "what you may do and settles a question you cannot.",
  );
  if (askers !== "") lines.push(`You take work from ${askers}.`);
  const handOffs = answers.list("hands_off");
  if (handOffs.length > 0) {
    lines.push("", "## What you pass on", "");
    for (const work of handOffs) {
      lines.push(`- ${work} is not your work: it goes to whoever owns it in the office.`);
    }
  }
  const how = answers.list("how_it_works");
  if (how.length > 0) {
    lines.push("", "## How you work", "");
    for (const rule of how) lines.push(`- ${rule}`);
  }
  return lines.join("\n");
}

/**
 * The problems of the answers as they stand: the spec parser's, the merged manifest's own checks (the
 * ones the generator will run before it writes anything), and the few the interview has to make for
 * itself. A document that parses can still be refused by the generator, so the interview runs both.
 */
export function problemsOf(answers: Answers): readonly Issue[] {
  const document = specDocument(answers);
  const parsed = parseRoleSpec(document, ROLE_SPEC_FILE);
  const own = answerIssues(answers);
  if (!parsed.ok) return [...parsed.issues, ...own];
  const merged = validateManifest(manifestFromRoleSpec(parsed.value), ROLE_SPEC_FILE);
  const fromManifest = merged.ok
    ? []
    : merged.issues.map((issue) => ({ ...issue, path: specPathFor(issue.path) }));
  return [...parsed.issues, ...dedupe([...fromManifest, ...own])];
}

/** The same problem once, when both the parser and the manifest report it at the same place. */
function dedupe(issues: readonly Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A problem the merged manifest reports as a manifest path, named the way the spec names it: the merge
 * keeps the manifest's field names and only adds the block each one lives in, so the mapping is the
 * block and nothing else.
 */
function specPathFor(path: string): string {
  const [head = "", ...rest] = path.split(".");
  const block = MANIFEST_BLOCKS[head];
  if (block === undefined) return path;
  return rest.length === 0 ? block : `${block}.${rest.join(".")}`;
}

/** The spec block each manifest field lives in, for a path the merged manifest reports. */
const MANIFEST_BLOCKS: Readonly<Record<string, string>> = {
  tools: "role.tools",
  runtimes: "role.runtimes",
  engine: "role.engine",
  limits: "role.limits",
  channels: "role.channels",
  connectors: "role.connectors",
  approvals: "wisdom.approvals",
  mayNot: "wisdom.authority.may_not",
  accepts: "workflow.accepts",
  commands: "workflow.commands",
  skills: "knowledge.skills",
};

/**
 * The checks the interview has to make for itself, because neither the spec parser nor the manifest
 * checks them, and a document that gets past both is one nobody reviewed:
 *
 * - **A comparison on a value that is not a number.** A wait compares its argument to a line with
 *   `gt`, `gte`, `lt` or `lte`. On a parameter that holds words the comparison cannot be made, and the
 *   gate fails safe — a value it cannot compare counts as holding, so the action waits for a person on
 *   *every* call. A person asked for a narrow wait and got a gate that stops the role every time.
 *   The interview knows what each parameter holds because it asked, so it refuses the answer here.
 */
export function answerIssues(answers: Answers): readonly Issue[] {
  const issues: Issue[] = [];
  answers.list("approvals").forEach((id, index) => {
    const at = `approvals[${index}]`;
    if (answers.text(`${at}.always`) === "every time the tool runs") return;
    const comparison = answers.text(`${at}.compare`);
    const op = COMPARISONS[comparison] ?? "eq";
    if (!NUMERIC_OPS.includes(op)) return;
    const tool = answers.text(`${at}.tool`).trim();
    const argument = answers.text(`${at}.arg`).trim();
    const found = parameterOf(answers, tool, argument);
    if (found === undefined) return;
    const { holds: type, path } = found;
    if (type === "number" || type === "integer") return;
    // The answer behind it is what the value holds, so that is the question asked again — the
    // comparison is the other half, and the message says both ways out of it. The problem is reported
    // at the parameter's own place in the spec, which is what a person reviewing the file would read.
    issues.push({
      source: ROLE_SPEC_FILE,
      path: `${path}.type`,
      message:
        `holds ${type === "boolean" ? "a yes or a no" : "words"}, and the wait "${id}" compares it ` +
        `with "${comparison}"; a number cannot be compared with it, so make this a number or change ` +
        "what the wait compares",
    });
  });
  return issues;
}

/** Where a tool's parameter is declared — its answer key and its place in the spec — and what it holds. */
function parameterOf(
  answers: Answers,
  tool: string,
  argument: string,
): { readonly key: string; readonly path: string; readonly holds: string } | undefined {
  const tools = answers.list("tools");
  const index = tools.indexOf(tool);
  if (index < 0) return undefined;
  const at = `tools[${index}].parameters`;
  const parameters = answers.list(at);
  const parameter = parameters.indexOf(argument);
  if (parameter < 0) return undefined;
  const key = `${at}[${parameter}]`;
  return {
    key,
    path: `role.tools[${index}].parameters.${argument}`,
    holds: PARAMETER_TYPES[answers.text(`${key}.type`)] ?? "string",
  };
}

/**
 * The questions behind a document's problems, each with the problems its own answers caused, and the
 * problems no answer explains.
 *
 * A problem is reported at a spec path; a question says which paths its answer is written to. The
 * match is the tightest one available: the question whose answer sits exactly where the problem is,
 * else the deepest one containing it, else the container's own question. A path several questions
 * share — the body, which every line of the role's context is written into — hands the problem to all
 * of them, because any of them could be the one that caused it.
 */
export function questionsBehind(issues: readonly Issue[], asked: readonly Asked[]): Problems {
  const questions: Reask[] = [];
  const other: Issue[] = [];
  const byKey = new Map<string, { asked: Asked; because: string[] }>();

  for (const issue of issues) {
    const found = tightest(issue.path, asked);
    if (found === undefined) {
      other.push(issue);
      continue;
    }
    for (const target of found) {
      const known = byKey.get(target.place.key);
      if (known === undefined)
        byKey.set(target.place.key, { asked: target, because: [issue.message] });
      else known.because.push(issue.message);
    }
  }

  for (const entry of byKey.values()) questions.push({ ...entry.asked, because: entry.because });
  return { questions, other };
}

/** The question, or questions, a problem at `path` belongs to. */
function tightest(path: string, asked: readonly Asked[]): readonly Asked[] | undefined {
  const ranked = asked
    .map((entry, order) => ({ entry, order, rank: rankOf(entry, path) }))
    .filter((candidate) => candidate.rank.rank !== undefined);
  if (ranked.length === 0) return undefined;

  const best = Math.min(...ranked.map((candidate) => candidate.rank.rank ?? 0));
  const atBest = ranked.filter((candidate) => candidate.rank.rank === best);
  // Two questions can share the path a problem is reported at — the role's context is written by
  // several — and both are behind it. Anything else takes the single closest one.
  if (best === 0) return atBest.map((candidate) => candidate.entry);
  const best2 = Math.min(...atBest.map((candidate) => candidate.rank.depth));
  const atBest2 = atBest.filter((candidate) => candidate.rank.depth === best2);
  const first = atBest2.sort((left, right) => left.order - right.order)[0]?.entry;
  return first === undefined ? undefined : [first];
}

/**
 * How well one question's answer matches a problem's path: `0` exactly, `1` the answer's own place
 * holds the problem, `2` the problem is at a container the answer fills part of — with the depth to
 * break a tie.
 */
function rankOf(
  asked: Asked,
  path: string,
): { readonly rank: number | undefined; readonly depth: number } {
  // Every path the answer is written to, including the extra ones a single answer declares.
  const places = [asked.place.path, ...(asked.question.writes ?? [])].filter(
    (place) => place !== "",
  );
  for (const place of places) {
    const depth = place.split(/[.[]/).length;
    if (place === path) return { rank: 0, depth };
    if (path.startsWith(`${place}.`) || path.startsWith(`${place}[`)) return { rank: 1, depth };
    if (place.startsWith(`${path}.`) || place.startsWith(`${path}[`)) return { rank: 2, depth };
  }
  return { rank: undefined, depth: 0 };
}
