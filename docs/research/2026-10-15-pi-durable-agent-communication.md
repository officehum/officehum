# Pi Durable leaves peer coordination to you

Pi Durable does not provide peer-to-peer coordination between agents. That is true of its features, though not of its building blocks. The package is `@earendil-works/pi-durable`; the name "PyDurable" does not appear in any source. It ships no peer-messaging API, agent directory, message envelope, mailbox abstraction, hop limit or cross-process channel. Its 5,352-line spec has zero hits for "peer", "agent-to-agent", "A2A", "mailbox" or "team". It does ship the primitives that make peer delivery easy to build inside one Session. Any trusted code that holds a conversation ID can submit input to that conversation. A `requestId` makes the submission exactly-once per conversation. Session-scoped documents can serve as a shared board. Upstream's own multi-agent story is hierarchical: a subagent is a task-owned child conversation, and a background "reporter" task posts each answer back to the parent. The ecosystem projects that do real peer messaging all come down to one move: submit into the other agent's durable inbox with a stable request ID, then add your own routing and guarantees on top. The main ones are mavam/pi-agents, rivet-dev/agents and pi-fabric. Community discussion on Hacker News, X, YouTube and blogs is only two weeks old. It centres on durability and on several humans steering one agent, not on agent-to-agent protocols, and Reddit could not be checked. For Office Hum this confirms the M2 design. The workboard and relay are exactly the layer Pi Durable leaves to applications, and setting `requestId` to the event id is the pattern Temporal, DBOS and Restate use. Five changes follow:

- Upgrade to 1.3.0 before building the relay. 1.2.0 adds typed input entries that can carry provenance, and its `content` to `output` rename breaks every tool.
- Give each ticket its own conversation per role.
- Record an aborted or failed delivery as a new workboard event instead of retrying the same request ID.
- Keep the dedup ledger in the workboard, not in conversations.
- Keep approvals in the workboard too.

## The claim holds for features, not for mechanics

Here is what the official sources say. The design notes put it plainly: "No built-in subagent tool or supervisor task" ([pico-v5-handoff §18, v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/pico-v5-handoff.md)). The announcement adds that "Pi Durable has no built-in subagents, but they take a few lines of code to build" ([Earendil blog](https://earendil.com/posts/pi-durable/)). The spec's Non-goals list says nothing about multi-agent messaging either way. Two of its entries do limit what a shared board can be: there is **no CRDT or offline multi-writer merge, and no session-scoped rewindable document** ([spec §13](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)). The blog promises only that "There is more coming". The README opens with "**Experimental.** The API changes without notice between releases" ([README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)). Searches of the issue tracker for durable peer, agent-to-agent, A2A, mailbox and cross-process found **no feature request or design issue for peer messaging** ([issue search](https://github.com/earendil-works/pi/issues?q=A2A)).

The mechanics, though, are fully open. Tools call `api.conversation(id)` and tasks call `runtime.conversation(id)`, and both accept any conversation in the Session. The spec says there is "no additional subtree authorization layer. Possession of a Session-global typed ID is sufficient in trusted code" ([spec §7.3](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)). The handle offers `submit`, `abort` and `waitForIdle`. It accepts only `type: "input"`, so a peer message always asks the recipient's model for a turn. A submission returns after durable admission, not after the work settles. "A retried submission with the same `requestId` returns the existing submission instead of submitting twice" ([README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)). When the recipient is busy, the input queues in its `pi.inbox` document as a **steer** (joins the current run after the tool round) or a **follow-up** (starts the next run) ([README "Busy Conversations"](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)). The blog sums it up: tools can "start tasks and conversations, and talk to other conversations" ([Earendil blog](https://earendil.com/posts/pi-durable/)). All of this holds only inside one process. "One process owns a storage at a time; there is no cross-process locking" ([README "Storage"](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)). Watches are in-process only: issue #10749 reported that a second process attached to the same SQLite file receives no events after it attaches, and no fix was added ([#10749](https://github.com/earendil-works/pi/issues/10749)). Upstream also deleted its experimental client/server stack on 2026-10-12 ([commit 7472cda0](https://github.com/earendil-works/pi/commit/7472cda0)).

| Question | Documented answer | Status |
|---|---|---|
| Built-in subagent or supervisor? | No; examples only | Documented ([handoff §18](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/pico-v5-handoff.md)) |
| Can one conversation submit to a peer conversation? | Yes, with any conversation ID in the Session | Documented ([spec §7.3](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)) |
| Delivery guarantee | Durable admission, deduplicated per (conversation, `requestId`) | Documented ([spec §2.2, §6](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)) |
| Exactly-once execution of side effects | No: "a replay-safe tool with external effects still needs its own idempotency" | Documented ([spec §7.3](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)) |
| Sender identity, reply-to, directory, hop limits, ordering across recipients | None | Inferred from the API surface and spec search |
| Shared board | Session-scoped documents, atomic commits, `watchDoc` | Documented ([spec §3, §9.2](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)); its use as a board is inferred |
| Messaging across processes or Sessions | None | Documented ([README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md), [#10749](https://github.com/earendil-works/pi/issues/10749)) |
| Concurrency cap across conversations | None found | Negative search result, not a documented statement |

So the user's claim is correct: Pi Durable provides no peer-to-peer coordination. The precise version is that it provides **peer delivery** (idempotent submission into any conversation, within one process) and leaves **coordination** to the application: who may message whom, why, how often, with what authority, and how replies come back.

## Upstream subagents are an ownership pattern, not a messaging layer

Earendil's examples treat multi-agent work as a problem of ownership and structured concurrency. A conversation is either ownerless or owned by a task, and the owner edge decides how far an abort reaches ([spec §5.5](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)).

**Example 22, foreground.** A tool with `replay: "safe"` creates or re-finds its child with `scanConversations({ ownerTaskId })` inside one commit. It strips the `Subagent` extension from the child so the child cannot spawn its own subagents. It then submits with `requestId: subagent:${api.taskId}` and blocks until the child answers ([example 22](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts)).

**Example 23, persistent and background.** Each child is owned by an "anchor": a background task that finishes immediately, so the subagent outlives the parent's turns. A tool with `spawn`, `send`, `stop` and `status` actions creates the anchor, the child and a **reporter** task in one commit. The reporter submits the message to the child, waits for the answer, records it as reported "so a restart does not decide again", and posts it back to the parent as a follow-up input formatted `[subagent <name> answered, no reply needed] <text>`. The example closes the harness mid-work and reopens it, and "after the restart its answer still arrives" ([example 23](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)).

**Example 24, child tasks.** It adds task-level fan-out and join, with `allSettled` or `failFast` policies ([example 24](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/24-child-tasks.ts)).

**Example 28, reviewer.** Often mistaken for agent-to-agent, it is not: the host submits to an ownerless reviewer conversation, and the main agent never messages it ([example 28](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/28-reviewer.ts)).

Three details matter for anyone copying these patterns.

First, the reporter is the **only documented way to push** a result into another conversation, and the result arrives as a user-role input that starts a new turn, not as a tool result. A recipient model therefore reads a peer's words with the standing of user input, and the label is only a text prefix (inference from the example code). Nothing documented lets a child ask its parent a question mid-run.

Second, the spec lists real footguns:

- "Foreground work an extension starts in a subagent's conversation holds the calling tool, and with it the run."
- A tool must not report an owned conversation's usage, because the child's `pi.usage` already counts it.
- Raw entries appended to a busy conversation "can misplace its system prompt entries; use a write submission."

All three are in [spec §12](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).

Third, **example 23 on main still returns `content`** from its `reply()` helper, although 1.2.0 renamed the field to `output`. Issue #10815 showed the same mistake in the coding agent's experimental copy silently handing the model an empty tool result. The maintainer closed it by removing that copy ([#10815](https://github.com/earendil-works/pi/issues/10815)). Do not copy that line verbatim (inference from reading the code against the changelog).

The authors' own history explains this shape. In 2025 Mario Zechner called in-session subagents "a black box within a black box" and parallel feature subagents "an anti-pattern" ([mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). Armin Ronacher favoured subagents for failure isolation, reporting back only success plus a short note on what failed, with a shared file-like layer as the coordination substrate ([lucumr.pocoo.org](https://lucumr.pocoo.org/2025/11/21/agents-are-hard/)). On the 515-point HN launch thread, Zechner rejected a comparison to the Gastown orchestrator ("I do not see any resemblence"). He described `requestId` as "an imdempotency key", and said syncing to external systems is done by a commit that "durably schedules a task" ([HN 49925969](https://news.ycombinator.com/item?id=49925969)). On X, the official account frames Durable around "long-running, multiplayer agents" ([@pidotdev](https://x.com/pidotdev/status/2107033061905104941)). Zechner's own test bed is a personal phone agent that "has subagents" ([X](https://x.com/badlogicgames/status/2106286641551675411)). In this material "multiplayer" means several humans steering one agent, not agents talking to each other. The X material comes from search snippets only, and no Reddit thread could be found or fetched, so treat Reddit as unchecked rather than silent.

## Practitioners converge on submitting into another agent's inbox

About 60 public repositories reference `@earendil-works/pi-durable` (a lower bound from code search), and nearly all are weeks old. A handful do real agent-to-agent communication, and they share one mechanism ([GitHub code search](https://github.com/search?q=%22%40earendil-works%2Fpi-durable%22+path%3Apackage.json&type=code)).

**mavam/pi-agents** has the most precisely specified contract. Agents discover each other with `agent_status` and send one-way messages with `agent_send`. A message steers a working recipient or waits as a follow-up. The documented guarantees are:

- "One recipient, once", across crashes, with the recipient bound by identity rather than name.
- Messages are logged before they are submitted.
- Acceptance order holds per sender-recipient pair.
- Stopped agents refuse messages.
- Outcomes are queued, delivered or dropped.

It explicitly does not provide request/reply, **send budgets or hop limits**, messages across Pi sessions, or exactly-once side effects. All of those are on its roadmap, ending with "messaging across Pi sessions through a broker" ([pi-agents messaging](https://github.com/mavam/pi-agents/blob/main/docs/messaging.md)). It pins pi-durable 1.2.0. Its agents cannot use MCP or other extensions' tools because Durable cannot host them yet ([pi-agents README](https://github.com/mavam/pi-agents/blob/main/README.md); [#10386](https://github.com/earendil-works/pi/issues/10386); [#10837](https://github.com/earendil-works/pi/issues/10837)).

**rivet-dev/agents** (1,607 stars) runs each agent as a durable actor. A coder's `request_review` tool calls a reviewer actor keyed by repository, and the reviewer submits the request into its own conversation without waiting. All coders share one reviewer with a memory of past reviews, and a busy reviewer queues the request as a follow-up ([rivet agent-to-agent](https://github.com/rivet-dev/agents/blob/main/docs/content/docs/agent-to-agent.mdx)).

**pi-fabric** publishes resident agents in a participant directory. Other trusted sessions can `ask`, `tell`, `steer`, `followUp` and `stop` them, and undelivered completion envelopes "survive disconnects" ([pi-fabric agents](https://github.com/fabric-runtime/pi-fabric/blob/main/docs/agents.md)).

**ambionframework/ambion** seats Pi Durable, Claude Agent SDK and Codex agents in a shared journal "room" ([ambion](https://github.com/ambionframework/ambion/blob/main/README.md)).

**disler/durable-pi**, the companion to a YouTube demo of proactive on-call agents, documents no direct messaging at all. Agents "hand facts" through one shared JSON app state with atomic path operations and a `409 conflict` on stale saves ([durable-pi](https://github.com/disler/durable-pi)).

Every cross-process design puts a host layer in front of the store (actors, Durable Objects, sockets, a resident host). None shares one Durable store between processes.

The much larger coding-agent ecosystem confirms the delivery idiom but not the durability. pi-subagents alone has about 3.9k stars. pi-messenger (720 stars) runs file-based rooms with presence, task claiming and **file reservations enforced by blocking tool calls**. It wakes recipients by injecting a steering message ([pi-messenger](https://github.com/nicobailon/pi-messenger/blob/main/README.md)). pi-intercom adds a `contact_supervisor` tool with `reason: "need_decision"` for blocking clarification ([pi-intercom](https://github.com/nicobailon/pi-intercom/blob/main/README.md)). None of these declares a dependency on pi-durable. The A2A adapters for Pi are single-author experiments with 0 to 11 stars, and **none targets Pi Durable** ([pi-a2a-communication](https://github.com/DrOlu/pi-a2a-communication/blob/main/README.md)).

Upstream auto-closes most community proposals for native orchestration, and its maintainers have commented on only a few. The agent-event-bus RFC ended with its author banned ([#2715](https://github.com/earendil-works/pi/issues/2715)). The coding agent's README says Pi "skips features like sub-agents" ([coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)). The inference is that peer messaging will stay a third-party concern for the foreseeable future.

## Durable engines agree: persist first, then deduplicate on the caller's key

Outside the Pi world, every durable-execution engine gets effectively-once handoffs the same way: persist the message before acknowledging it, then deduplicate on a caller-chosen key at the receiver.

- **Temporal** deduplicates Updates by Update ID, but "per Workflow run", so dedup must move into workflow code across Continue-As-New ([Temporal](https://docs.temporal.io/handling-messages)).
- **DBOS** persists every message and guarantees exactly-once delivery for sends from inside a workflow. Writes from a retried step are only at-least-once ([DBOS](https://docs.dbos.dev/python/tutorials/workflow-communication)).
- **Restate** gives one writer per key and returns the original result for a duplicate idempotency key ([Restate](https://docs.restate.dev/foundations/key-concepts)).

The orchestration SDKs state no cross-process guarantee at all. OpenAI's handoffs "stay within a single run", and a handoff proceeds unless `on_handoff` raises ([OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/)). A2A says its messages "MUST NOT be considered a reliable delivery mechanism for critical information". It makes messageId deduplication optional and push notifications at-least-once ([A2A spec](https://a2a-protocol.org/latest/specification/)).

The reported failure modes are predictable:

- **Runaway spawning and duplicated work.** Anthropic's early research agents spawned "50 subagents for simple queries", and multi-agent runs cost about **15 times** the tokens of chat ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **Non-terminating LLM routers**, mitigated with `maxIter` ([AgentKit](https://agentkit.inngest.com/concepts/networks)).
- **Conflicting implicit decisions** between agents that do not share traces ([Cognition](https://cognition.com/blog/dont-build-multi-agents)).
- **Cross-agent prompt injection**, which A2A does not defend against at the protocol level ([Wiz](https://www.wiz.io/academy/ai-security/a2a-protocol)).

Recent research favours the blackboard shape Office Hum chose. A shared-board design matched or beat static and dynamic multi-agent baselines while using fewer tokens ([arXiv 2507.01701](https://arxiv.org/abs/2507.01701)). Another reported up to 9% relative F1 gain over master-worker designs, because the coordinator no longer needs to know every agent's abilities ([arXiv 2510.01285](https://arxiv.org/abs/2510.01285v2)). An append-only ticket log adds what those prototypes lack: an audit trail, replay, and a natural dedup key. It also answers Cognition's objection, because the accepting role can read the whole ticket history instead of a lossy message (inference).

## What Office Hum should build

Office Hum already runs the core delivery pattern in its Front Desk inbound-email code. `packages/office/src/inbound-session.ts` creates an ownerless conversation per sender inside one commit. It configures that conversation's agent and records the route in a document. It then submits with a stable request ID derived from the email and saves the admitted submission ID in a host-side ledger. The M2 relay is the same machine with a workboard event in place of an email. The recommendations below are inferences built on the documented facts above.

### Upgrade to 1.3.0 before writing relay code

Office Hum pins exactly 1.0.2 in `packages/office`, `packages/cli` and `packages/sdk`. Role packages declare `1.0.x` as a peer range, and AGENTS.md states that range as a hard rule. Between 1.0.2 and 1.3.0, three changes bear directly on the relay ([CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md); [README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)):

| Version | Change | Why it matters for M2 |
|---|---|---|
| 1.2.0 | Input submissions may carry `entry: { kind, data }`; 1.0.2 types it as `entry?: never` | Puts structured provenance (ticket id, event id, sending role, hop, origin) into the recipient's transcript as data, not just prompt text |
| 1.2.0 | `ToolExecutionResult.content` renamed to `output` | Breaking change for every Office Hum tool; the failure is silent (empty tool result, per [#10815](https://github.com/earendil-works/pi/issues/10815)) |
| 1.2.0 | Wait cycles rejected at `commit()` instead of hanging; a background task may wait on its conversation's owner | Turns an accidental A-waits-on-B-waits-on-A into an error instead of a stuck office |
| 1.2.0 | Display-only writes append immediately, even mid-run | Lets the host show relay status in a busy conversation without starting a model turn |
| 1.2.0 | `abortOwned`, `ownedTasks`, `executeTool`, scheduler scaling, unobserved docs evicted after `documentRetentionMs` | Useful for in-role helpers and for many concurrent ticket conversations |
| 1.3.0 | Shared operation queue and table prefixes for Cloudflare Durable Object storage | Not relevant to local SQLite |

The upgrade should widen the role peer range (and the AGENTS.md rule that states it) to the new minor version. Pin the runtime to an exact version, because the API "changes without notice". The design documents linked from the 1.0.2 README were also deleted from main on 2026-10-12, so read them at the v1.0.0 tag ([commit 6db4070f](https://github.com/earendil-works/pi/commit/6db4070f)).

### Build the relay as an outbox that never reuses a request ID for a retry

The workboard is the system of record. Pi Durable's own deduplication lives in each conversation (`submissionByRequest(conversationId, requestId)`, [spec §3.3](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)), so it disappears if a role conversation is replaced or rotated. That is the same trap as Temporal's per-run dedup. The relay therefore records, for each event, the target conversation, the submission ID, and the settlement result from `Submission.wait()`.

The relay works in this order:

1. The board tool commits the event.
2. The relay looks up or creates the accepting role's conversation for the ticket.
3. It submits `{ type: "input", whenBusy: "followUp", requestId: eventId, entry: { kind: "officehum.handoff", data } }`.
4. It saves the admission.
5. On restart it scans for events that have no settled admission and submits them again.

The same `requestId` makes the resubmission harmless, which is exactly the crash window the spec describes: a host "first finds its conversation again" and then retries ([spec §2.2](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)).

The non-obvious part is failure. An input can settle `unanswered` with reason `aborted`, `stale`, `reset` or `model_error` ([spec §2.2](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)). An abort "drops its queued messages", and a human pressing Esc drops queued input ([example 23](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)). Resubmitting with the same `requestId` just returns the dead submission. Treat redelivery as a new workboard event, such as `redelivered` or `stalled`, with its own id. That keeps the invariant `requestId == eventId` true and leaves an audit trail.

After a failed run, "queued items stay in the inbox until the next input or queued write places them" ([README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)). The relay needs a watchdog for conversations that are idle but still have queued input.

Use `watchEvents` or `subscribeCommits` only to wake the relay early. They are in-process, convergent and lossy under overflow ("not an audit stream", [spec §9.2](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)), and `subscribeCommits` listeners must not block or call Session APIs.

The board tools that roles call to post events must be idempotent in their own right. If a tool is `replay: "safe"`, key the event on `api.taskId`, never on the provider's tool-call ID, which "must not serve as request IDs" ([spec §7.3](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)). Any external effect a role triggers (an invoice, an email) stays keyed on ticket plus action, as `resend-replies` already does.

### Give each ticket its own conversation per role

Submitting every hand-off into one long-lived conversation per role has three costs. It serializes the role behind a single busy run. It grows context without bound. It lets text from one customer's ticket sit in the prompt while another customer's ticket is handled.

The upstream-endorsed alternative is many concurrent conversations in one harness. The blog maps a Slack channel to a conversation and each thread to a fork, and the two run "at once" ([Earendil blog](https://earendil.com/posts/pi-durable/)). For Office Hum, give the relay a `(role, ticketId)` route, held in a document like the existing `InboundConversationDoc` route table, that resolves to an ownerless conversation configured with the role's agent. Use a fork of a role's "home" conversation if shared standing context is wanted.

Three documented details shape this:

- A fork starts with an empty `pi.inbox`.
- A new ownerless conversation starts with an empty agent, so configure it in the creating commit, as `inbound-session.ts` already does.
- `conversationCreated` runs in every commit that creates or forks a conversation, and can install per-conversation documents ([README "Your Own State"](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)).

Keep ticket conversations **ownerless**, not task-owned. Ownership defines abort scope, and one role's Esc must not cancel a peer's work. Reserve task-owned subagents (the example 22 or example 23 shape) for helpers private to one role, and strip the subagent tool from the child as example 22 does.

No global concurrency cap exists in the spec (a negative search result). The relay therefore has to enforce per-role and per-provider concurrency itself.

### Keep approvals and hop limits outside the model's reach

Under the reporter convention, a peer's hand-off reaches the recipient as a user-role input. The model cannot tell a role's words from the owner's except by labels. Three rules follow from that:

- **Labels and provenance.** Every relayed input carries a visible label in the content (example 23's `[subagent ... answered]` convention) and machine-readable provenance in `entry.data`.
- **Approvals as host events.** A human approval exists only as a workboard event written by the host. Gated tools check it in a hook and fail closed when none is present, which is the same lesson as OpenAI's `on_handoff`. Nothing in a hand-off's text can satisfy a gate.
- **Hops and ping-pong refused in the relay.** It counts hops per ticket and refuses a route that returns to the sending role on the same ticket (A to B to A) unless a human event intervened. This is exactly what pi-agents lists as missing.

Because routing goes by ticket type rather than by the model naming a recipient, Office Hum also avoids the non-termination problem of LLM routers.

Never have one role synchronously wait on another. Waits go through the workboard. That makes the 1.2.0 cycle check a safety net rather than a dependency.

### Study three projects and copy one contract

| Source | Action | What to take |
|---|---|---|
| Durable examples 22, 23, 24 ([examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples)) | Adopt for in-role helpers | Create plus submit in one commit, `requestId` from the task id, reporter posting back as a follow-up, `allSettled` joins; fix `content` to `output` |
| mavam/pi-agents [messaging.md](https://github.com/mavam/pi-agents/blob/main/docs/messaging.md) | Copy its guarantee contract into the relay spec | "One recipient, once", log before submit, per-pair ordering, stopped recipients refuse, queued/delivered/dropped outcomes, plus Office Hum's additions (hop limits, approvals) |
| rivet-dev/agents [agent-to-agent](https://github.com/rivet-dev/agents/blob/main/docs/content/docs/agent-to-agent.mdx) | Study | Recipient addressed by key, fire-and-forget submit, follow-up queueing; a model for the gateway's inbound side |
| pi-fabric [agents.md](https://github.com/fabric-runtime/pi-fabric/blob/main/docs/agents.md) | Study for Studio and gateway | Participant directory, completion envelopes that survive disconnects |
| pi-messenger [README](https://github.com/nicobailon/pi-messenger/blob/main/README.md) | Study one idea | Reservations enforced by blocking tool calls, a pattern for exclusive work on a ticket |
| DBOS and Temporal docs | Reference | Workflow-level versus step-level guarantees; dedup that does not survive a new "run" |

### Cross-office hand-offs need a gateway Pi Durable will not provide

Pi Durable has nothing for messaging between Sessions or processes. Its only multi-client path, attaching to the owning process, lost its reference implementation on 2026-10-12. The gateway for RASF-3101/3110 is therefore entirely application code.

A2A 1.0 is the natural outward face. A ticket maps to a Task, ticket events map to Messages and Artifacts, and an approval wait maps to `INPUT_REQUIRED` or `AUTH_REQUIRED` ([A2A spec](https://a2a-protocol.org/latest/specification/)). But everything reliable has to come from Office Hum:

- Deduplicate inbound messageIds into an inbox table.
- Post accepted messages to the workboard as events with `external:<office>` provenance, so the relay's own `requestId == eventId` rule takes over.
- Handle pushes idempotently.
- Verify Agent Card signatures and keep allowlists of peer offices. Signing is optional in the spec, and card spoofing has been demonstrated ([LevelBlue](https://www.levelblue.com/blogs/spiderlabs-blog/agent-in-the-middle-abusing-agent-cards-in-the-agent-2-agent-protocol-to-win-all-the-tasks)).

No Durable-native A2A adapter exists, so Office Hum would be first. That cuts both ways: there is nothing to reuse and nothing to conflict with.

### Risks to plan for

| Risk | Evidence | Mitigation |
|---|---|---|
| API churn breaks tools silently | "Experimental", `content` to `output` rename, design docs deleted | Exact pins, a contract test per tool asserting non-empty `output`, upgrade on a branch with evals |
| A second process opens the store | No cross-process locking; watches in-process only ([#10749](https://github.com/earendil-works/pi/issues/10749)) | Studio and CLI talk to the runtime process; never open the SQLite file directly while it runs |
| Queued hand-offs dropped by abort or Esc | Abort drops queued messages ([example 23](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)) | Relay records settlement; `aborted` becomes a new workboard event |
| Peer text treated as user authority or injection | Relayed input is user-role; A2A has no injection defence ([Wiz](https://www.wiz.io/academy/ai-security/a2a-protocol)) | Provenance entries, approvals only as host events, gated tools fail closed |
| Duplicate external side effects | "Not exactly-once execution" ([spec §7.3](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)) | Key effects on ticket plus action; board tools keyed on `api.taskId` |
| Cost and runaway hand-offs | About 15 times chat tokens for multi-agent ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)) | Hop limits, per-ticket budgets, per-role concurrency caps in the relay |
| Roles cannot use MCP or extensions | [#10386](https://github.com/earendil-works/pi/issues/10386), [#10837](https://github.com/earendil-works/pi/issues/10837) | Office Hum's rule that roles author tools with `defineTool` already avoids this; keep connectors as tools |

## Conclusion

The question was whether Pi Durable lacks peer coordination. The more useful finding is that the gap sits exactly where Office Hum's roadmap already planned to build. Pi Durable's maintainers drew the line deliberately. The runtime guarantees that a message is admitted once and survives a crash. Everything that makes a message *legitimate* is left to applications: who may send it, under what authority, how many hops deep, and with what human sign-off. Every serious project on top of it has rebuilt that layer in its own way. Office Hum's workboard is a stronger version than any of them, because its dedup key, audit trail, routing and approvals all live in one append-only log the host controls. The biggest shift in thinking is about failure. The happy path is solved by `requestId == eventId`. Correctness depends on the unhappy paths: aborted inputs, queues stranded after a failed run, rotated conversations. All of them have to become first-class workboard events, never silent retries.

A practical sequencing follows. Land RASF-3237 (the 1.3.0 upgrade, the `output` rename, typed provenance entries) before RASF-3066/3067/3109. Lift `inbound-session.ts`'s route-and-admission machinery into a general relay. Write pi-agents' guarantee contract, extended with hop limits and approvals, into the M2 spec before the code. If that contract holds inside one process, the same `requestId == eventId` rule can extend through an A2A gateway later without redesigning anything.
