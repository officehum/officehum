/**
 * The four memory tools. Each is `replay: "safe"`: `memory_save` derives its record id from the
 * conversation and call id, so an interrupted save that runs again finds the record it already
 * wrote; forgetting and setting the focus give the same result however often they run. The saving,
 * forgetting and focus tools change something (they "write" in manifest terms) and are still safe to
 * run again.
 *
 * The model chooses a record's subject, kind, category and text. Code sets everything else, and the
 * guardrails run here, before the commit: secrets are refused, payment details force the protected
 * category, a protected category is refused from every source and handed to the host's reviewer
 * (only an owner sets one, through the host's protected form), and the status follows the source and
 * kind. Storage refuses the tools any change to a protected record (`WriteAuthority`).
 */

import {
  defineTool,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { textResult } from "@officehum/sdk";
import type { MemoryOptions } from "./extension.js";
import { framedRecords, newestFirst, recordLine } from "./format.js";
import {
  CATEGORIES,
  type Category,
  KINDS,
  MAX_TEXT,
  type MemoryRecord,
  type MemorySource,
  normalSubject,
  recordId,
  SubjectSchema,
  statusFor,
} from "./record.js";
import { scanText } from "./scan.js";
import {
  isProtectedCategory,
  readFocus,
  readIndex,
  readRecords,
  retireRecord,
  saveRecord,
  setFocus,
  type Visible,
} from "./storage.js";
import { visibleIn } from "./view.js";

/** The source in a bare harness: every message is the local user's own. */
export const LOCAL_USER_SOURCE: MemorySource = { type: "person", ref: "local-user" };

const DEFAULT_RECALL = 10;
const MAX_RECALL = 50;
const MAX_FOCUS = 20;
/**
 * How many ids a host's search is asked for: enough that the ones this conversation may not see
 * still leave a full answer.
 */
const SEARCH_LIMIT = 200;
/** Never shown by recall: retired records are forgotten; superseded ones are archived. */
const HIDDEN = new Set<string>(["retired", "superseded"]);

const refused = (text: string) => ({ isError: true, output: [{ type: "text" as const, text }] });

export function memoryTools(options: MemoryOptions): ToolRegistration[] {
  const now = options.now ?? (() => new Date());
  const author = `agent:${options.role}`;
  const scope = options.scope ?? author;
  /** What this call's conversation may see, from the host's view; everything in a bare harness. */
  const visibleTo = async (
    api: ToolExecutionApi,
    context: Parameters<ToolExecutionApi["commit"]>[1],
  ): Promise<Visible> => {
    const view = await options.viewOf?.({ conversationId: api.conversationId, read: api, context });
    return (record) => visibleIn(view, record);
  };

  const save = defineTool({
    name: "memory_save",
    description:
      "Remember one fact, preference, rule or procedure about one subject, for later conversations. One fact per record; correct an old record by passing its id as supersedes.",
    parameters: obj(
      {
        about: SubjectSchema,
        kind: oneOf([...KINDS], {
          description:
            "fact or preference; rule (how agents should act) or procedure (how something is done), which a person must approve",
        }),
        category: oneOf([...CATEGORIES], {
          description:
            "general, contact, schedule or payment_terms; payment_details and authority only an owner sets",
        }),
        text: str({
          minLength: 1,
          maxLength: MAX_TEXT,
          description: "The one fact, dated if it is time-bound",
        }),
        supersedes: opt(
          str({
            description: "The id of the record about the same subject this one corrects",
          }),
        ),
        reviewAt: opt(
          str({
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description:
              "YYYY-MM-DD. Set it whenever the fact says when it ends or should be looked at again " +
              '("until March", "for the next quarter", "through the summer"): the first day of the ' +
              "month or period it names, or the exact date when it gives one. With no year, use the next " +
              "such date after today. Leave it out only for a fact with no end.",
          }),
        ),
      },
      { open: true },
    ),
    replay: "safe",
    execute: async (args, api, context) => {
      const about = normalSubject(args.about);
      const text = args.text.trim();
      const scan = (options.scan ?? scanText)(text);
      if (scan.secret !== undefined) {
        return refused(
          `Not saved: the text contains ${scan.secret}. Secrets are never remembered; keep them in the business's password manager.`,
        );
      }
      const category: Category =
        scan.paymentDetails === undefined ? args.category : "payment_details";
      const source =
        (await options.sourceOf?.({
          conversationId: api.conversationId,
          callId: api.callId,
          api,
          context,
        })) ?? LOCAL_USER_SOURCE;
      const id = recordId(String(api.conversationId), api.callId);

      // Whoever the conversation is with, an owner included: an agent hearing it is not the
      // protected form, so the claim goes to an owner and nothing is stored.
      if (isProtectedCategory(category)) {
        const forced =
          category === args.category ? "" : ` (the text contains ${scan.paymentDetails})`;
        const reason = `${category}${forced} is set only by an owner, in the protected form, never by an agent's save`;
        await options.onReview?.({
          key: id,
          reason,
          about,
          kind: args.kind,
          category,
          text,
          source,
          conversationId: api.conversationId,
          callId: api.callId,
        });
        return refused(
          `Not saved: ${reason}. ${options.onReview === undefined ? "Until" : "An owner has been asked to review it; until"} an owner sets it, do not use it or give it to anyone as fact.`,
        );
      }

      const { status, reason } = statusFor(args.kind, source);
      const record: MemoryRecord = {
        id,
        about,
        kind: args.kind,
        category,
        text,
        scope,
        source,
        status,
        ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
        createdAt: now().toISOString(),
        createdBy: author,
        ...(args.reviewAt === undefined ? {} : { reviewAt: args.reviewAt }),
      };
      const visible = await visibleTo(api, context);
      const outcome = await api.commit(async (tx) => {
        const saved = await saveRecord(tx, record, visible);
        // Only a record written now: a replay finds it `existing`, and the host wrote its part then.
        if (saved.kind === "saved") {
          await options.onSaved?.({
            tx,
            record: saved.record,
            conversationId: api.conversationId,
            callId: api.callId,
          });
        }
        return saved;
      }, context);
      if (outcome.kind === "refused") return refused(`Not saved: ${outcome.message}`);

      const saved = outcome.record;
      const notes = [
        `Saved ${saved.id} about ${saved.about} as ${saved.status}: ${reason}.`,
        ...(category === args.category
          ? []
          : [`Its category is payment_details because the text contains ${scan.paymentDetails}.`]),
        ...(saved.supersedes === undefined
          ? []
          : outcome.pending === true
            ? [
                `It will replace ${saved.supersedes} once a person approves it; until then ${saved.supersedes} still applies.`,
              ]
            : [`It replaces ${saved.supersedes}, now superseded.`]),
      ];
      return {
        output: [{ type: "text", text: notes.join(" ") }],
        details: { id: saved.id, status: saved.status, category: saved.category },
      };
    },
  });

  const recall = defineTool({
    name: "memory_recall",
    description:
      "Look up what agents remembered: about one given subject, or the conversation's focus subjects; with keywords and neither, across every subject. Each record shows its subject and id.",
    parameters: obj(
      {
        query: opt(str({ description: "Keywords to match; omit for the newest records" })),
        about: opt(SubjectSchema),
        limit: opt(
          int({
            minimum: 1,
            maximum: MAX_RECALL,
            description: `The most records to return, best matches first (default ${DEFAULT_RECALL}); set it when only the top few are wanted`,
          }),
        ),
      },
      { open: true },
    ),
    replay: "safe",
    execute: async (args, api, context) => {
      const words = (args.query ?? "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 1);
      const named =
        args.about === undefined
          ? await readFocus(api, api.conversationId, context)
          : [normalSubject(args.about)];
      // Keywords with no subject search everything this conversation may see, so a record can be
      // found (and its id read, to supersede it) without first guessing its exact subject key.
      const everywhere = named.length === 0 && words.length > 0;
      const subjects = everywhere ? Object.keys((await readIndex(api, context)).subjects) : named;
      if (subjects.length === 0 && !everywhere) {
        return textResult(
          "No subject to look in: pass about, set what this conversation is about with memory_focus, or search by keywords.",
        );
      }
      const visible = await visibleTo(api, context);
      const records: MemoryRecord[] = [];
      for (const about of subjects) {
        records.push(
          ...(await readRecords(api, about, context)).filter(
            (record) => !HIDDEN.has(record.status) && visible(record),
          ),
        );
      }
      const limit = args.limit ?? DEFAULT_RECALL;
      let found: MemoryRecord[];
      if (options.search !== undefined && words.length > 0) {
        // The host's ranking, over the records this conversation may see; a hidden or invisible id
        // it returns is simply not among them.
        const byId = new Map(records.map((record) => [record.id, record]));
        const ranked = await options.search({ words, subjects, limit: SEARCH_LIMIT });
        found = ranked
          .map((id) => byId.get(id))
          .filter((record) => record !== undefined)
          .slice(0, limit);
      } else {
        const score = (record: MemoryRecord) => {
          const haystack = `${record.text} ${record.about} ${record.category}`.toLowerCase();
          return words.filter((word) => haystack.includes(word)).length;
        };
        found = records
          .filter((record) => words.length === 0 || score(record) > 0)
          .sort((a, b) => score(b) - score(a) || newestFirst(a, b))
          .slice(0, limit);
      }
      if (found.length === 0) {
        if (everywhere) return textResult(`Nothing remembered matches "${args.query}".`);
        return textResult(
          `Nothing remembered about ${subjects.join(", ")}${words.length === 0 ? "" : ` matches "${args.query}"`}.`,
        );
      }
      return textResult(framedRecords("memory_recall", found.map(recordLine).join("\n")));
    },
  });

  const forget = defineTool({
    name: "memory_forget",
    description:
      "Retire a record that is wrong or no longer matters. It stops being recalled but stays stored for history.",
    parameters: obj(
      {
        id: str({ description: "The record's id, mem_…" }),
        reason: str({ minLength: 1, maxLength: 300, description: "Why it no longer holds" }),
      },
      { open: true },
    ),
    replay: "safe",
    execute: async (args, api, context) => {
      const visible = await visibleTo(api, context);
      const outcome = await api.commit(
        (tx) => retireRecord(tx, args.id, args.reason, now().toISOString(), visible),
        context,
      );
      if (outcome.kind === "missing") {
        return refused(`There is no current record ${args.id}. Recall the subject to find its id.`);
      }
      if (outcome.kind === "refused") return refused(`Not forgotten: ${outcome.message}`);
      return textResult(
        `Forgot ${outcome.record.id} about ${outcome.record.about}: it is retired and kept for history.`,
      );
    },
  });

  const focus = defineTool({
    name: "memory_focus",
    description:
      "Say which subjects this conversation is about, so their records appear in your context and recall searches them.",
    parameters: obj(
      {
        about: arr(SubjectSchema, { maxItems: MAX_FOCUS }),
      },
      { open: true },
    ),
    replay: "safe",
    execute: async (args, api, context) => {
      const about = args.about.map(normalSubject);
      await api.commit((tx) => setFocus(tx, api.conversationId, about), context);
      return textResult(
        about.length === 0
          ? "This conversation has no focus subjects now."
          : `This conversation is about ${[...new Set(about)].join(", ")}.`,
      );
    },
  });

  return [save, recall, forget, focus];
}
