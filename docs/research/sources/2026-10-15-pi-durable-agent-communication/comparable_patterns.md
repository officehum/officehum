# Comparable patterns: reliable peer communication between durable agents (reference designs for a Pi Durable office)

Research date: 2026-10-15. Every claim below has an inline source. Content fetched from the web was treated as data. Several official pages returned only partial coverage, and LangGraph's old docs domain redirected; those limits are recorded under Gaps.

## Q1. How do Temporal, Restate, DBOS, Inngest AgentKit, Cloudflare Agents/Durable Objects, LangGraph, OpenAI Agents SDK, AutoGen/Agent Framework and A2A implement agent-to-agent messaging, and what do they guarantee?

### Takeaway
The durable-execution engines (Temporal, Restate, DBOS) give effectively-once handoffs the same way: the message is persisted before it is acknowledged, and a caller-supplied ID is deduplicated. Temporal dedups Update IDs (per run). Restate and DBOS dedup idempotency keys. DBOS also makes a send from inside a workflow exactly-once. The agent-orchestration SDKs (OpenAI Agents SDK, LangGraph, Inngest AgentKit, AutoGen Core) model a handoff as an in-run control transfer or a pub/sub publish, and the pages reviewed state no cross-process delivery guarantee. A2A explicitly calls itself not a reliable delivery mechanism and leaves duplicate detection on messageId optional. Office Hum's planned "requestId = event id" relay therefore matches the durable-engine pattern, which is the right family to copy.

### Cited Findings

**Temporal (Signals, Updates, Nexus)**
- Mechanism: Signals are asynchronous writes, and the sender can't await a result or error. Updates are synchronous, tracked writes, and the sender can wait for a result or failure. Queries are reads that never add entries to history. An accepted Update is recorded in Event History. — [Temporal: Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)
- Updates are validated before they enter history and must wait for the Worker to acknowledge them. Signals don't depend on Worker availability. Signals have no per-workflow concurrency limit, while Updates do. — [Temporal: Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)
- Dedup guarantee: "For Updates, Temporal handles this for you on the server, by deduplicating according to the Update ID". For Signals you "should use a custom idempotency key that you send as part of your own signal inputs" and check it in workflow code. Request IDs also dedupe retried client calls automatically. — [Temporal: Handling messages](https://docs.temporal.io/handling-messages)
- Caveat: "Update ID deduplication by the server is per Workflow run", so after Continue-As-New you must dedupe in workflow code. Docs advise waiting for all handlers to finish before a run completes or continues as new. — [Temporal: Handling messages](https://docs.temporal.io/handling-messages)
- Nexus connects workflows across namespaces, clusters, regions and clouds. Its operations can be sync or async and long-lived. An async operation gets an ID the caller can re-attach to. Caller-side retries are tracked in the caller workflow, like Activities. — [Temporal Nexus operations](https://docs.temporal.io/nexus/operations); [Temporal Nexus evaluate](https://docs.temporal.io/evaluate/nexus)
- Temporal's Nexus announcement claims "at-least-once and exactly-once execution guarantees" but doesn't say which applies where. — [Temporal blog: Announcing Nexus](https://temporal.io/blog/announcing-nexus-connect-temporal-applications-across-isolated-namespaces)
- Relevance to Office Hum: dedupe each accepted handoff on a stable ID. The relay's requestId = event id is equivalent to an Update ID. Persist the dedup set beyond any conversation compaction or "continue-as-new" analogue, because Temporal's own dedup is only per run.

**Restate (Virtual Objects, durable RPC, awakeables)**
- Restate "tracks each invocation through completion, ensuring it runs exactly once regardless of failures". Its RPC promises "No duplicates: Same call won't execute twice". It "tracks every step of your code execution in a journal" and records both the operation and its result for service calls. — [Restate key concepts](https://docs.restate.dev/foundations/key-concepts)
- Virtual Objects give a "Single-writer guarantee: Only one handler can modify state at a time" per key, with isolated K/V state kept indefinitely. — [Restate key concepts](https://docs.restate.dev/foundations/key-concepts); [Restate durable building blocks](https://docs.restate.dev/concepts/durable_building_blocks)
- With an idempotency key in the request headers, Restate dedupes, and "Duplicate requests will return the same result as the original request". — [Restate key concepts](https://docs.restate.dev/foundations/key-concepts)
- Call styles are request-response, one-way send (the caller "continues immediately") and delayed send. An awakeable is "a one-shot signal" with a generated ID that an external system resolves or rejects. Durable promises are resolved once and read many times. — [Restate durable building blocks](https://docs.restate.dev/concepts/durable_building_blocks)
- Relevance to Office Hum: a role agent maps naturally to a keyed Virtual Object (a single writer per role conversation). A human approval maps to an awakeable or durable promise, which the approval UI resolves by ID.

**DBOS (send/recv, events, streams, durable queues)**
- "All messages are persisted to the database". Messages are queued per topic on the receiver, and `recv()` consumes the next message on that topic, or returns None on timeout. — [DBOS workflow communication](https://docs.dbos.dev/python/tutorials/workflow-communication)
- "If you're sending a message from a workflow, DBOS guarantees exactly-once delivery". Sends from non-workflow code get the same guarantee by passing an `idempotency_key` to `DBOS.send`. — [DBOS workflow communication](https://docs.dbos.dev/python/tutorials/workflow-communication)
- Events are key/value and last-writer-wins. A value read inside a workflow is persisted so recovery reuses it. Streams are "immutable and append-only". Writes from a workflow are exactly-once, but "Writes to a stream from a step happen at-least-once", so retried steps can duplicate. — [DBOS workflow communication](https://docs.dbos.dev/python/tutorials/workflow-communication)
- Relevance to Office Hum: this is the closest analogue to a single-store design. Handoff messages are rows in the same database as workflow state, written inside the durable step, and topics play the role of ticket types. The step-versus-workflow distinction is the key lesson: anything an agent's tool step emits is at-least-once unless keyed.

**Inngest AgentKit (networks, routers, state)**
- A network is agents plus shared State plus a Router. It behaves as "while loops with memory" that run until the router decides no work remains. State holds message history and a K/V store visible to the Router and to other agents' tools. — [AgentKit networks](https://agentkit.inngest.com/concepts/networks)
- Routers can be code-based (they return the next agent or undefined), a routing agent, or a hybrid. `maxIter` caps iterations, which is recommended with LLM routers because they "can sometimes fail to identify a final condition". — [AgentKit networks](https://agentkit.inngest.com/concepts/networks)
- Relevance to Office Hum: this is an orchestrator loop with shared state, not peer messaging. `maxIter` is the same mitigation as Office Hum's hop limit.

**Cloudflare Agents / Durable Objects**
- `getAgentByName()` returns a typed stub for server-side RPC. Each unique name gets "its own isolated agent with its own state". `routingRetry` retries transient routing failures. — [Cloudflare Agents: calling agents](https://developers.cloudflare.com/agents/api-reference/calling-agents/)
- Each Durable Object is single-threaded. Input gates block new events during storage operations. Output gates delay outgoing messages until writes persist, so "clients never see confirmation of data that has not been persisted". Non-storage I/O such as `fetch()` lets other requests interleave. — [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- Alarms "may fire more than once. Your `alarm()` handler should be safe to run multiple times". SQLite is the recommended storage backend, and writes with no `await` between them are batched into one transaction. RPC errors carry `.retryable` and `.overloaded`. The page doesn't state RPC delivery semantics. — [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- Relevance to Office Hum: "one actor plus SQLite per agent" is close to Office Hum's single-process, single-SQLite layout. The lesson is to treat schedule and alarm triggers and RPC retries as at-least-once and to dedupe at the receiver.

**LangGraph / LangChain multi-agent**
- Documented patterns are subagents (a main agent calls subagents as tools, and they "start fresh each time"), handoffs ("Agents transfer control to each other via tool calls"), skills, router, and custom workflow. — [LangChain multi-agent overview](https://docs.langchain.com/oss/python/langchain/multi-agent)
- Handoff tools return `Command(goto=..., update=..., graph=Command.PARENT)`. They must include a `ToolMessage` with the matching `tool_call_id`, or "the conversation history becomes malformed". The example passes only the handoff AIMessage/ToolMessage pair to keep context focused. State is persisted through a checkpointer (the example uses `InMemorySaver`). — [LangChain handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)
- Docs warn: "Subgraph handoffs require careful context engineering". Otherwise agents get "malformed conversation history or bloated context". Designers must decide whether handoff tools "only update routing state or also perform side effects". — [LangChain handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)
- Relevance to Office Hum: keep handoff tools side-effect-free (they write a workboard event and nothing else). Hand over a curated summary, not the full transcript.

**OpenAI Agents SDK handoffs**
- "Handoffs are represented as tools to the LLM" (for example `transfer_to_refund_agent`). `input_type` gives typed, locally validated handoff arguments that are passed to `on_handoff`. `input_filter` controls what history the next agent sees. — [OpenAI Agents SDK: Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- Approval and authorization guidance: `is_enabled` "cannot authorize values inside an argument-bearing handoff". Checks belong in `on_handoff`, which must raise to block, because the transfer continues if it returns normally. — [OpenAI Agents SDK: Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- Nested-history summaries (beta) do "not redact sensitive data". "Handoffs stay within a single run". No durability or delivery guarantee is stated. — [OpenAI Agents SDK: Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- Relevance to Office Hum: borrow typed handoff schemas and fail-closed authorization in the handoff hook. Durability must come from the host (the workboard), not the SDK.

**Microsoft AutoGen Core (actor runtime, topics)**
- AutoGen Core supports direct messaging (the sender gives the recipient's agent ID) and broadcast through topics (topic type plus source). Subscriptions map topics to agent IDs, and type-based subscriptions are preferred. The runtime creates agents on demand. — [AutoGen topics and subscriptions](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/topic-and-subscription.html)
- The only stated delivery rules: a topic with no subscription is not delivered to anyone, and with several subscriptions each recipient gets the message "only once". Nothing is stated on ordering, persistence or retries. — [AutoGen topics and subscriptions](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/topic-and-subscription.html)
- Relevance to Office Hum: "ticket type → subscribed role" mirrors type-based subscriptions. AutoGen gives no durability, so Office Hum's persisted event log is the stronger design.

**Google A2A protocol**
- The latest spec is 1.0.0 (earlier versions 0.3.0, 0.2.6 and 0.1.0), and clients send an `A2A-Version` header. Task states are SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED and REJECTED (all but the first two are terminal), plus interrupted states INPUT_REQUIRED and AUTH_REQUIRED. A client resumes an interrupted task by sending with the same taskId and contextId. — [A2A specification](https://a2a-protocol.org/latest/specification/)
- Messages carry `messageId`, `contextId`, `taskId` and `referenceTaskIds`. Results "SHOULD BE returned using Artifacts". — [A2A specification](https://a2a-protocol.org/latest/specification/)
- Guarantees: "Send Message operations MAY be idempotent", and agents may use messageId to detect duplicates. Cancel is idempotent. Streaming events MUST arrive in generation order. "Messages MUST NOT be considered a reliable delivery mechanism for critical information". — [A2A specification](https://a2a-protocol.org/latest/specification/)
- Push notifications: agents "MUST attempt delivery at least once" per webhook and MAY retry with backoff. "Clients SHOULD process notifications idempotently, as duplicate deliveries may occur". Clients MUST validate the task ID and answer 2xx to acknowledge. — [A2A specification](https://a2a-protocol.org/latest/specification/)
- Relevance to Office Hum: A2A's task model (input-required, auth-required, artifacts) maps well onto tickets and approvals. Office Hum's gateway must still add its own idempotency (messageId → event id) and an inbox table, because the spec makes neither mandatory.

### Inferences
- Across the durable engines, effectively-once is always **persist-then-ack plus dedup on a caller-chosen key at the receiver**. None of them gives exactly-once for external side effects inside non-durable steps (see DBOS step-level streams and Cloudflare alarms). Office Hum's relay should therefore (a) write the workboard event and the relay-attempt record in one SQLite transaction (outbox), (b) submit with requestId = event id, (c) have the Pi Durable receiver reject or return the cached result for a seen requestId (inbox), and (d) key each external side effect (invoice, email) on ticket ID plus action.
- Office Hum's single process with one SQLite store removes the network leg that most of these systems defend against. The remaining duplicate sources are crash-between-steps replays and LLM-driven re-emission, meaning the agent calling the handoff tool twice.
- The Temporal per-run caveat applies by analogy: if Pi Durable compacts or restarts a conversation, the dedup ledger must live in the workboard, not in the conversation.

### Gaps
- I didn't verify the 2025–2026 merger of AutoGen and Semantic Kernel into "Microsoft Agent Framework" or its durability (for example a Durable Task-backed runtime). Only the AutoGen Core topics page was fetched.
- The Inngest page didn't explain how AgentKit networks get durability from Inngest steps (memoized step results).
- I found no technical Temporal doc stating Nexus dedup windows or exactly-once conditions; the claim appears only in marketing.
- The Cloudflare Agents `schedule()` semantics and sub-agent docs were not fetched.
- DBOS SQLite support and table names weren't confirmed on the page fetched, which mentions only a Postgres function.

## Q2. Which patterns are orchestrator/hierarchical versus peer, and what failure modes and mitigations are reported?

### Takeaway
Most agent SDKs ship orchestrator or handoff patterns: supervisor, subagents-as-tools, a router loop, or control transfer within one run. Only AutoGen (topics), A2A (task exchange between opaque peers) and the blackboard research systems are truly peer-oriented. Reported failures cluster around duplicated work, runaway spawning or looping, context loss or bloat at handoff boundaries, and authorization gaps in handoff hooks. The documented mitigations line up closely with Office Hum's plan: stable IDs and dedup, iteration or hop caps, typed handoff schemas, curated history filters, and fail-closed approval hooks.

### Cited Findings
- Orchestrator/hierarchical examples: LangChain subagents ("A main agent coordinates subagents as tools") and router — [LangChain multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent). Inngest AgentKit Router loop — [AgentKit networks](https://agentkit.inngest.com/concepts/networks). Anthropic's orchestrator-worker research system — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system).
- Handoff (control transfer, one active agent): OpenAI Agents SDK ("Handoffs stay within a single run") — [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/). LangGraph `Command.PARENT` handoffs — [LangChain handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs).
- Peer/pub-sub: AutoGen broadcast topics, where senders don't name recipients and which suits event-driven workflows — [AutoGen topics](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/topic-and-subscription.html). A2A has opaque agents collaborating through tasks — [A2A specification](https://a2a-protocol.org/latest/specification/).
- Mailbox/actor with durable state: Restate Virtual Objects (single writer per key) — [Restate key concepts](https://docs.restate.dev/foundations/key-concepts). DBOS per-topic receiver queues — [DBOS communication](https://docs.dbos.dev/python/tutorials/workflow-communication). Cloudflare single-threaded Durable Objects — [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

**Failure modes reported**
- **Taxonomy:** MAST ("Why Do Multi-Agent LLM Systems Fail?", Cemri et al., v1 March 2025, v3 October 2025) defines 14 failure modes in 3 categories: system design issues, inter-agent misalignment, and task verification. It is built from 150 traces with annotator kappa 0.88 and released with 1,600+ annotated traces across 7 frameworks. It finds multi-agent gains on benchmarks "often minimal". — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657)
- **Duplicate work and runaway spawning:** early Anthropic agents spawned "50 subagents for simple queries", and vague delegation led subagents to duplicate each other's work. The fix was explicit effort-scaling rules, task boundaries and output formats. — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Cost:** agents use about 4× the tokens of chat, and multi-agent systems about 15×. — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Context loss ("game of telephone"):** Anthropic's mitigation is to have subagents write outputs to external storage and pass lightweight references. — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Conflicting implicit decisions:** Cognition argues "Actions carry implicit decisions, and conflicting decisions carry bad results" (the Flappy Bird example). Its advice is to "Share context, and share full agent traces, not just individual messages" and to default to a single-threaded linear agent with history compression (Walden Yan, June 12, 2025). — [Cognition: Don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents)
- **Context bloat and malformed history at handoff:** LangChain warns of "malformed conversation history or bloated context" — [LangChain handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs). The OpenAI SDK's nested-history summaries do "not redact sensitive data" — [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/).
- **Non-termination and loops:** LLM routers "can sometimes fail to identify a final condition". Mitigate with `maxIter`. — [AgentKit networks](https://agentkit.inngest.com/concepts/networks)
- **Approval and authorization bypass:** in the OpenAI SDK, the transfer proceeds unless `on_handoff` raises, and `is_enabled` can't authorize argument values. — [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/)
- **Cross-agent prompt injection and confused deputy:** hostile content in task results can drive a downstream agent, and chained agents propagate it. A vendor analysis claims A2A has no protocol-level injection defense, citing a Unit 42 proof of concept (vendor source, weigh accordingly). — [grith.ai](https://grith.ai/blog/a2a-protocol-zero-defenses-prompt-injection); [Wiz Academy](https://www.wiz.io/academy/ai-security/a2a-protocol). arXiv 2506.23260 lists discovery spoofing and cross-agent injection as A2A-layer threats. — [arXiv 2506.23260](https://arxiv.org/pdf/2506.23260)
- **Duplicates from retries:** DBOS step-level stream writes are at-least-once — [DBOS](https://docs.dbos.dev/python/tutorials/workflow-communication). Cloudflare alarms can fire more than once — [Cloudflare](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/). A2A push notifications may arrive more than once — [A2A spec](https://a2a-protocol.org/latest/specification/).

**Mitigations (mapped to sources)**
- Idempotency keys and dedup at the receiver: Temporal Update ID, and custom keys for Signals — [Temporal](https://docs.temporal.io/handling-messages). Restate idempotency header — [Restate](https://docs.restate.dev/foundations/key-concepts). DBOS `idempotency_key` — [DBOS](https://docs.dbos.dev/python/tutorials/workflow-communication). A2A messageId (optional) — [A2A](https://a2a-protocol.org/latest/specification/).
- Persist-before-acknowledge (outbox-like): Cloudflare output gates — [Cloudflare](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/). DBOS persisted messages — [DBOS](https://docs.dbos.dev/python/tutorials/workflow-communication).
- Hop or iteration caps: AgentKit `maxIter` — [AgentKit](https://agentkit.inngest.com/concepts/networks).
- Typed handoff schemas: OpenAI `input_type` — [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/).
- Curated history: OpenAI `input_filter`, and LangGraph passing only the handoff pair — [OpenAI](https://openai.github.io/openai-agents-python/handoffs/); [LangChain](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs).
- Resume from checkpoint rather than restart, plus rainbow deployments so in-flight agents aren't broken — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system).
- Per-agent credentials, allowlisting, runtime authorization, and treating peer output as untrusted — [Wiz Academy](https://www.wiz.io/academy/ai-security/a2a-protocol).

### Inferences
- Office Hum's design is a **hybrid**. The workboard is a blackboard (shared, append-only state), the relay is a deterministic code router, which avoids LLM-router non-termination, and each role agent is a mailbox-style actor. This sits between the AgentKit pattern (code router plus shared state) and the Restate/DBOS pattern (durable keyed actors with persisted messages).
- Provenance labels close the gap that A2A and the OpenAI SDK leave open. A handoff payload produced by a model, or containing customer text, should never count as an approval. Approvals must be host-recorded events that the relay checks, consistent with the OpenAI guidance to fail closed in hook code rather than trust the model.
- A routed-by-type relay avoids most "ping-pong" risk, because agents can't pick arbitrary recipients. A hop limit per ticket plus a rule that rejects A→B→A on the same ticket would cover the rest.

### Gaps
- The MAST abstract page doesn't list the 14 individual failure modes (for example step repetition or ignoring another agent's input). The full PDF wasn't fetched, so mode names are not cited here.
- I found no primary-source write-up of ping-pong (A↔B) loops specifically. Mitigation evidence is limited to iteration caps.
- There are no first-party "approval bypass via injected text" incident reports from the framework vendors themselves; evidence is from security vendors and one arXiv survey.

## Q3. What do practitioners and recent research (2025–2026) say about blackboard/workboard architectures versus direct messaging?

### Takeaway
Recent academic work (2025–early 2026) reports that blackboard-style LLM multi-agent systems are competitive with or better than master/worker and direct-messaging designs, and often cheaper in tokens. Their advantage is that a coordinator doesn't need to know every agent's capabilities. Practitioner guidance (Anthropic, Cognition) converges on a related point: share durable artifacts and references rather than relaying messages. Even so, the guidance stays cautious about parallel peers making conflicting decisions.

### Cited Findings
- Han & Zhang (arXiv 2507.01701, July 2025) put every agent on a shared board. Agents are selected based on board content, and the cycle repeats until consensus. On commonsense, reasoning and math benchmarks they report the best average performance against static and dynamic multi-agent baselines, with fewer tokens. — [arXiv 2507.01701](https://arxiv.org/abs/2507.01701)
- Salemi et al. (arXiv 2510.01285, September 2025, revised January 2026) argue that master–slave designs need a central controller that knows each sub-agent's abilities. In their blackboard design, the main agent posts requests to a board and file or search agents volunteer. They report up to 9% relative F1 gain in data discovery over the best baselines, across proprietary and open models. — [arXiv 2510.01285](https://arxiv.org/abs/2510.01285v2)
- Anthropic stores subagent outputs externally and passes references, to avoid a "game of telephone" through the coordinator. They also note that synchronous orchestration means "the lead agent can't steer subagents, subagents can't coordinate", while async adds state-consistency and error-propagation complexity. — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Cognition argues against parallel agents that don't share full traces, favoring a single thread with compression. — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Inngest AgentKit's shared State (history plus K/V, readable by the router and by agents' tools) is a production blackboard-lite. — [AgentKit networks](https://agentkit.inngest.com/concepts/networks)
- The A2A spec says results "SHOULD BE returned using Artifacts" rather than messages, which is an artifact-centric rather than chat-centric exchange. — [A2A specification](https://a2a-protocol.org/latest/specification/)

### Inferences
- A **workboard with append-only ticket events** is a blackboard with stronger engineering properties than the research prototypes: an audit trail, replayability and a natural dedup key (event id). It also answers Cognition's concern, because the accepting agent can read the full ticket history (the trace) rather than a lossy message.
- The research blackboards rely on an LLM control unit to choose who acts. Office Hum's deterministic routing by ticket type gives up some flexibility in exchange for predictability and loop resistance, which is reasonable for business operations such as bookkeeping and sales.
- Context bloat risk moves to "how much of the ticket does the relay put in the conversation". Anthropic's reference-passing suggests submitting a compact summary plus a ticket ID that the agent can fetch through a tool.

### Gaps
- The PatchBoard paper (arXiv 2605.29313, schema-grounded shared state) was named only in a GitHub README found through search. I didn't open it, so it is unverified.
- I found no controlled study comparing blackboard and direct messaging specifically for long-running durable business agents. All the results above are from QA, reasoning or data-discovery benchmarks.

## Q4. How do A2A and MCP fit as external interfaces for cross-organization handoffs, and what are the adoption and security caveats?

### Takeaway
A2A is the agent-to-agent layer: opaque peers, a task lifecycle, artifacts and push notifications. MCP is the agent-to-tool layer. For cross-office handoffs, A2A's task model fits tickets well. However, its idempotency is optional (MAY), delivery is explicitly unreliable, push is at-least-once, Agent Card signing is optional, and the protocol has no prompt-injection defense. A gateway would need to add an inbox/outbox, mandatory messageId dedup, signed cards and peer allowlists, and treat all peer content as untrusted.

### Cited Findings
- The A2A spec is at 1.0.0, and the spec site banner says "A2A joins the Agentic AI Foundation". — [A2A specification](https://a2a-protocol.org/latest/specification/)
- Google donated A2A to the Linux Foundation in June 2025, and IBM's ACP merged into A2A in August 2025. A2A is reported to have 150+ supporting organizations (including Atlassian, Salesforce, SAP and ServiceNow) and enterprise adoption by April 2026. These figures come from secondary commentary I couldn't verify against a primary source. — [philippdubach.com](https://philippdubach.com/posts/mcp-vs-a2a-in-2026-how-the-ai-protocol-war-ends/); [beam.ai](https://beam.ai/agentic-insights/agent2agent-vs-mcp-2026-ai-agent-stack)
- MCP connects an agent to tools, and A2A connects agents to each other, so the two are complementary. One analysis reports 10,000+ MCP servers and says 53% of MCP servers rely on static credentials rather than OAuth (secondary source). — [philippdubach.com](https://philippdubach.com/posts/mcp-vs-a2a-in-2026-how-the-ai-protocol-war-ends/)
- Spec security: servers MUST reject invalid or missing credentials and MUST NOT reveal resources the client can't access. Agent Cards "MAY be digitally signed using JSON Web Signature (JWS)", canonicalized with JCS, and clients "SHOULD verify at least one signature before trusting an Agent Card". Push requests MUST carry the configured auth headers, and clients MUST validate the task ID. — [A2A specification](https://a2a-protocol.org/latest/specification/)
- Agent Card spoofing ("agent-in-the-middle") is reported: a malicious card can win task routing. Public `/.well-known/agent-card.json` endpoints let attackers map agents. A Semgrep finding says A2A "supports but does not enforce Agent Card signing". — [LevelBlue SpiderLabs](https://www.levelblue.com/blogs/spiderlabs-blog/agent-in-the-middle-abusing-agent-cards-in-the-agent-2-agent-protocol-to-win-all-the-tasks); [grith.ai](https://grith.ai/blog/a2a-protocol-zero-defenses-prompt-injection)
- Other reported risks are confused deputy, unscoped delegation and privilege escalation, and stolen broad credentials. Suggested mitigations are per-agent credentials, allowlisting, runtime authorization and treating peer output as untrusted. — [Wiz Academy](https://www.wiz.io/academy/ai-security/a2a-protocol)
- Within Temporal's ecosystem, Nexus is the comparable "durable cross-boundary" option. It links namespaces, clusters, regions and clouds, with re-attachable operation IDs and retries tracked in the caller. — [Temporal Nexus operations](https://docs.temporal.io/nexus/operations)

### Inferences
- For Office Hum's later gateway protocol, A2A is the natural external face: ticket ↔ Task, ticket events ↔ Messages and Artifacts, approval-needed ↔ INPUT_REQUIRED or AUTH_REQUIRED, contextId ↔ ticket thread. The internal guarantees (event-id dedup, hop limits, provenance) must be enforced at the gateway, because A2A only says MAY.
- Inbound A2A content should land on the workboard as an event with provenance "external:<office>". It must never reach an agent with authority to approve. Human approvals should remain local host events.
- MCP fits as the way each role agent reaches tools (ledger, CRM), not as the handoff channel between offices.

### Gaps
- I couldn't fetch A2A §13.2 on push notification security (SSRF and replay guidance). Only partial push-auth text was read.
- I didn't confirm the Agentic AI Foundation's governance relationship to A2A and MCP from a primary Linux Foundation source.
- Adoption figures (150+ organizations, MCP server counts) are from secondary blogs only.
- I found no primary data on production cross-organization A2A deployments with durable delivery.
