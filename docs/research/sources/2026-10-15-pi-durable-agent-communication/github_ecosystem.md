# Pi Durable agent communication: GitHub and npm ecosystem

Scope note: researched 2026-10-15 using the `gh` CLI (issue, PR, discussion, code and repo search) and `npm view` / `npm search`. GitHub code search only indexes default branches and caps results at 100, so the dependents list is a lower bound. Star counts and dates are as of 2026-10-15/16. Pi Durable is young: the npm package was first published 2026-09-19, 1.0.0 shipped 2026-10-01, and 1.3.0 is current (2026-10-15). Most multi-agent work in the Pi world still sits on the coding agent (`AgentSession`), not on Pi Durable.

## 1. What has been asked, proposed or decided in earendil-works/pi about multi-agent communication

### Takeaway
The maintainers keep sub-agents and multi-agent coordination out of the coding-agent core and leave them to extensions. Almost every community proposal for native subagents, orchestration or cross-session buses was auto-closed (the repo auto-closes issues from new contributors) and got no maintainer reply. Pi Durable is the exception: its core has a real subagent model (task-owned child conversations, background tasks, an inbox with request-ID deduplication), shown in official examples. The live open asks are about letting Durable host extensions and MCP so that durable agents can do what coding-agent agents do.

### Cited Findings
**Official stance and core primitives**
- The coding-agent README says Pi "skips features like sub-agents and plan mode" and tells users to build them or install a package. — [coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- The repo ships an extension example folder `examples/extensions/subagent` and an in-process `event-bus.ts` example. The bus is for extensions inside one process, not across sessions. — [examples/extensions](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions); [#2714](https://github.com/earendil-works/pi/issues/2714) describes `event-bus.ts` as "inter-extension, not cross-session"
- Pi Durable describes itself as a "Durable conversation, task, and document runtime for Pi" (npm 1.3.0, created 2026-09-19). It depends on `@earendil-works/chord`, `pi-ai` and `pi-codemode`. — [npm @earendil-works/pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
- In the Durable README, a conversation can be **owned by a task**. A subagent tool creates the child in `api.commit()` with `ownership: { kind: "task", taskId }` and drives it with `api.conversation(id).submit(...)`. With `replay: "safe"`, a rerun after a crash finds the same child through the ownership index, and a `requestId` dedupes the submission. Aborting the call aborts the child. The parent is idle only once the child is. A `{ background: true }` task is a boundary: what it owns survives the parent's abort. — [Durable README, "Abort and Subagents"](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#abort-and-subagents)
- Two official examples: `22-subagent-foreground.ts` (a blocking subagent tool) and `23-subagent-background.ts`. The second runs "persistent subagents behind one `subagent` tool that spawns, messages (steer or follow-up), waits for, stops, and lists them". Each child is owned by a background anchor task. A background reporter task posts each answer back to the parent as a follow-up input, and request IDs stop a restart from sending a message or report twice. — [Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#abort-and-subagents); [test/examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples)
- Other Durable communication primitives: submissions to a busy conversation queue in a `pi.inbox` document and are placed as steer or follow-up. "Writes" (an entry of only `kind`/`data`) append immediately even mid-run. Typed **documents** can be committed atomically with entries. `harness.taskGraph()` exposes every live task and its owner edges. Child tasks can wait on each other with `allSettled`/`failFast` policies. — [Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- Storage constraint relevant to multi-process setups: "One process owns a storage at a time; there is no cross-process locking." — [Durable README, Storage](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#storage)
- 1.2.0 (2026-10-12) added `executeTool()` nested tool calls, `abandonOnRestart`, `abortOwned`/`ownedTasks`, and rejection of wait cycles through waits and held owners. 1.3.0 (2026-10-15) let several Pi storages share one Cloudflare Durable Object database. — [Durable CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md)

**Issues and discussions (newest first)**
- #10978 "Peer name: use session/tab label and support rename" (2026-10-15, auto-closed, no-action). A user running "pi teammates in herdr (gr-pi-peer)" with `PI_CLAUDE_PEER=1` says `send_peer_message`/`list_peers` see only a generated id that rotates on re-register. — [#10978](https://github.com/earendil-works/pi/issues/10978)
- #10837 "durable: MCP extension for Harness hosts" (2026-10-12, by mavam, auto-closed, no-action). Proposes a durable MCP extension with `mcp__<server>__<tool>` tools and replay policy derived from MCP `readOnlyHint`/`idempotentHint`. — [#10837](https://github.com/earendil-works/pi/issues/10837)
- #10815 "experimental durable: subagent tool returns empty result" (2026-10-12, label `durable`). The coding agent's experimental durable `subagent.ts` still returned `content` after Durable renamed it to `output`, so the parent got nothing. Maintainer badlogic: "this example has been removed". Closed 2026-10-12. — [#10815](https://github.com/earendil-works/pi/issues/10815)
- #10610 (2026-10-07, auto-closed). Steer and follow-up messages sent from an idle main thread while background subagents (a `SubagentWorkflow`) run get drained into a *subagent's* turn instead of the main thread. — [#10610](https://github.com/earendil-works/pi/issues/10610)
- #10386 "Durable: host coding-agent extensions (AgentSession-backed runtime or hook parity)" (2026-10-03, **open, reopened**, label `durable`):
  - The reporter runs headless sub-agents through the SDK. After moving extension-free roles to pi-durable 1.0.0, they saw "45 forced SIGKILL recoveries (15 each for 3 roles), 0 duplicate completed tool steps, 1.8 to 2.9 ms/step SQLite cost".
  - Roles that need compaction, session or dynamic-loadout hooks must stay on `AgentSession`.
  - No maintainer comment is visible, but the issue was reopened.
  - [#10386](https://github.com/earendil-works/pi/issues/10386)
- Discussion #10447 (2026-10-04) shows off pi-durabletask-mcp, which lets Claude Code or Codex delegate background tasks to Pi over MCP, with steer, follow-up and optional SQLite durable mode. — [discussion #10447](https://github.com/earendil-works/pi/discussions/10447)
- Discussion #10069 "agent-chat: peer-to-peer messaging for independent Pi agents (no orchestrator)" (2026-09-26):
  - Uses a localhost-only TCP server and three tools (`agent_chat_register`, `agent_chat_list`, `agent_chat_send`).
  - Messages arrive as user or steering messages, with delivered/buffered/failed acks.
  - It exists to coordinate shared Docker, ports and databases across worktrees.
  - [discussion #10069](https://github.com/earendil-works/pi/discussions/10069)
- #9218 (2026-09-06, auto-closed). pi-subagents background children need `@earendil-works/pi-server` and `@earendil-works/pi-client`, which `pi-coding-agent@0.85.1` did not declare as dependencies. — [#9218](https://github.com/earendil-works/pi/issues/9218)
- #8023 "Extension API: acknowledge durable custom-message publication" (2026-08-12, auto-closed). It asks for `publishMessage(): Promise<{entryId}>` that resolves once the message is persisted. On 2026-10-10 mavam added that pi-agents needs it for exactly-once delivery of durable agents' results into the parent session, and asked for it to be reopened. — [#8023](https://github.com/earendil-works/pi/issues/8023)
- #7412 "Native sub-agent support with isolated context windows" (2026-08-01, auto-closed, NOT_PLANNED). It notes users need 3 extensions (pi-subagents, pi-flow-skills, bmad-pi-orch) to match OpenCode. — [#7412](https://github.com/earendil-works/pi/issues/7412)
- #6710 "Orchestrator package has zero tests" (2026-07-16). It describes `packages/orchestrator/` with `ipc/server.ts`, `ipc/client.ts`, `supervisor.ts`, `rpc-process.ts` and `radius.ts` (presence and heartbeat). Maintainer mitsuhiko: "This is work in progress". The package was then renamed to `server` in PR #6898 (2026-07-21). — [#6710](https://github.com/earendil-works/pi/issues/6710); [PR #6898](https://github.com/earendil-works/pi/pull/6898)
- #5077 "Multi-Agent Orchestration System" (2026-05-27). A PRD for a `call_agent` tool; the author withdrew it: "my AI submitted to the wrong repository". — [#5077](https://github.com/earendil-works/pi/issues/5077)
- #2714 and #2715 "RFC: Agent Event Bus ... for Cross-Session Coordination" (2026-03-30). They propose connecting Pi sessions to an external `agent-event-bus` MCP server (`register_session`, `publish_event`, `get_events`). badlogic banned the author for "self-promotion", "ignoring CONTRIBUTING.md" and "letting your agent shit all over the repo". — [#2714](https://github.com/earendil-works/pi/issues/2714); [#2715](https://github.com/earendil-works/pi/issues/2715)
- Earlier issues name extensions directly: #2416 "Teams: animated progress indicator + drill-into-agent inspection", #2385 "agent-teams: team_status reports dead panes as active + add team_peek tool", #2249 "mom: add a quiet Slack mode". — [#2416](https://github.com/earendil-works/pi/issues/2416); [#2385](https://github.com/earendil-works/pi/issues/2385); [#2249](https://github.com/earendil-works/pi/issues/2249)
- `pi-mom`, the Slack bot that "delegates messages to the pi coding agent", was removed from the monorepo on 2026-04-30 ("remove mom and pods packages"). Its last npm release was `@mariozechner/pi-mom@0.70.6`. — [commit 0ed0d43](https://github.com/earendil-works/pi/commit/0ed0d434397f847c3a4b8b0444e2808d1169b15a); [npm @mariozechner/pi-mom](https://www.npmjs.com/package/@mariozechner/pi-mom)
- Searches of issues and discussions for "A2A", "mailbox" and "agent to agent" found nothing relevant in earendil-works/pi. — [issue search](https://github.com/earendil-works/pi/issues?q=A2A)

### Inferences
- Upstream's direction is clear: the coding agent will not ship native subagents, but Pi Durable's data model (ownership, background boundaries, inbox, requestId dedup) is the maintainers' own answer to durable parent–child delegation. Peer-to-peer and cross-process messaging are left to third parties.
- Removing the experimental durable subagent from the coding agent (#10815) suggests the reference subagent patterns now live in Durable's own examples (22, 23), not in the coding agent.
- The open gaps that block durable multi-agent setups are extension and MCP hosting (#10386, #10837) and a commit-acknowledged message publication API (#8023).

### Gaps
- No maintainer design doc or roadmap on multi-agent or A2A for Durable turned up. Maintainer replies were found only on #2715, #6710 and #10815.
- I could not find the source of the "herdr gr-pi-peer" / `PI_CLAUDE_PEER` peer registry in #10978. Code search for `PI_CLAUDE_PEER` returned no hits.
- The search returned no merged PRs about multi-agent; the repo seems to auto-close outside PRs, as it does issues, but I did not verify this directly.

## 2. Public repos that depend on @earendil-works/pi-durable and how their agents communicate

### Takeaway
About 60 repos reference `@earendil-works/pi-durable` in a `package.json` (code search, lower bound). Most are single-agent hosts: Cloudflare/Durable Object wrappers, desktop or mobile UIs, Swift and other ports. A handful do real multi-agent communication:
- **mavam/pi-agents**: durable named agents, graphs, one-way agent-to-agent messages with explicit guarantees. The most complete example.
- **rivet-dev/agents**: an agent per actor; agent-to-agent through actor RPC that submits into the target's durable conversation.
- **ambionframework/ambion**: shared journal "rooms" mixing Pi Durable, Claude Agent SDK and Codex seats.
- **fabric-runtime/pi-fabric**: mesh topics, mailboxes, shared tasks and CAS state, with a pi-durable runner.
- **TerseAI/durable-actors**, **botiverse/oar**, **AltanS/collie** and **thruwire/foreman** wrap or supervise Pi Durable agents.

All of them are weeks old.

### Cited Findings
**Dependents list** (from `gh search code '"@earendil-works/pi-durable"' --filename package.json`): Acode-Foundation/acode-ai-agent, AltanS/collie, CherryHQ/cherry-studio-app, DeevsDeevs/deevs-pi-kit, IgorWarzocha/pi-durable-components, ImYoyoData/pi-desktop, Nyarlathoteppppp/pi-durabletask-mcp, Parcha-ai/agentrun, SawyerHood/do-computer, ShigureLab/nyako, TannerMidd/pi-pocket, TerseAI/durable-actors, acoyfellow/capa, acoyfellow/coil, ambionframework/ambion, bivalve-ai/toaster, botiverse/antiproton, botiverse/oar, bubbleptr/dureview, bubbleptr/pinomad, chaoxu/xean, choyiny/gitorange, cloudflare/agents, cosmyo/ha-pi-durable, daya0576/pi-imessage, ejpir/pig, fabric-runtime/pi-fabric, finnvoor/PiDurableKit, galaxyproject/galaxy-visualizations, galaxyproject/loom, getlarge/themoltnet, hachej/boring-ui, harshil1712/pi-on-cf, heyhuynhgiabuu/pi-task, huang-sh/PiX, joelhooks/rat-king, just-be-dev/cafe-stack, kyashrathore/Claxedo, lucasmeijer/AgentsInTheCloud, mattiacerutti/supernova, mavam/pi-agents, mitkox/esf, narumiruna/pi-extensions, neavo/LinguaGacha, nicholasgriffintn/ai-platform, oqtopus-team/qdash, powerfooI/roamgate, richardanaya/pi-orbs, rivet-dev/agents, schani/pi-orb, seed-hypermedia/seed, sugarforever/pi-durable-mini-agent, thruwire/foreman, tonbo-io/ursula, and others. — [GitHub code search](https://github.com/search?q=%22%40earendil-works%2Fpi-durable%22+path%3Apackage.json&type=code)

**mavam/pi-agents** (★59, created 2026-03-01; npm `pi-agents` 0.33.0 pins `@earendil-works/pi-durable` 1.2.0) — [repo](https://github.com/mavam/pi-agents); [npm](https://www.npmjs.com/package/pi-agents)
- Gives Pi "durable, named agents" that run inside the Pi process on pi-durable, with "one pi-durable harness per Pi session, with its own store, kept apart from Pi's session file". Results come back to the parent as messages. — [README](https://github.com/mavam/pi-agents/blob/main/README.md)
- Graphs of 2 to 12 agents (fan-out/merge, pipeline, diamond). Edges carry only final messages ("no references, schemas, loops, or conditions"). Only the sink agents report to Pi. A delegating agent can spawn private "helpers". — [docs/graphs.md](https://github.com/mavam/pi-agents/blob/main/docs/graphs.md)
- Agent-to-agent messaging uses two tools: `agent_status` for discovery and `agent_send` for one-way send without waiting. A message steers a working recipient, or waits with `followUp`. — [docs/messaging.md](https://github.com/mavam/pi-agents/blob/main/docs/messaging.md)
- Documented guarantees — [docs/messaging.md](https://github.com/mavam/pi-agents/blob/main/docs/messaging.md):
  - "One recipient, once": the recipient is bound by identity, not name, and the message enters the recipient's conversation once, even across a crash or restart.
  - Messages are logged before they are submitted.
  - Acceptance order holds per sender–recipient pair.
  - Stopped agents refuse messages.
  - Outcomes are queued, delivered or dropped.
  - The parent model does not see inter-agent messages.
- Explicitly not provided: request/reply with waits, messages to or from `main`, send budgets or hop limits, messages across Pi sessions, exactly-once side effects. Roadmap: replies with required timeouts and cycle refusal, messages to main, limits, then "messaging across Pi sessions through a broker". — [docs/messaging.md](https://github.com/mavam/pi-agents/blob/main/docs/messaging.md)
- Caveat: agents cannot use MCP servers or other extensions' tools (citing pi #10837 and #10386), only `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` and `codemode`. — [README](https://github.com/mavam/pi-agents/blob/main/README.md)

**rivet-dev/agents** (★1,607; "A durable process per agent, with memory that survives restarts") — [repo](https://github.com/rivet-dev/agents)
- Runs Pi as durable Rivet Actors (`@rivet-dev/pi`, `@rivet-dev/sandbox-adapter`). — [README](https://github.com/rivet-dev/agents/blob/main/README.md)
- "Agent-to-Agent Messages" doc: a coder agent's `request_review` tool calls `client.reviewer.getOrCreate([repo]).requestReview(...)`. The reviewer action does `c.pi.root(...).submit({type:"input"})` and returns without waiting. The reviewer is keyed by repository, so all coders share one reviewer whose conversation remembers past reviews. A busy reviewer queues the request as a follow-up. — [agent-to-agent.mdx](https://github.com/rivet-dev/agents/blob/main/docs/content/docs/agent-to-agent.mdx); [coder.ts](https://github.com/rivet-dev/agents/blob/main/examples/docs/agent-to-agent/coder.ts); [server.ts](https://github.com/rivet-dev/agents/blob/main/examples/docs/agent-to-agent/server.ts)
- "Subagents" doc: a lead's tool calls a specialist actor by key. Each question goes to a fresh specialist keyed by an id that `api.memo` saves. With `replay: "safe"`, a rerun reuses the same id as `requestId`. Cancelling the lead cancels the specialist. — [subagents.mdx](https://github.com/rivet-dev/agents/blob/main/docs/content/docs/subagents.mdx)
- The repo also has docs examples for connectors (Slack, Discord, GitHub, Linear), background jobs, agent-per-key and human-in-the-loop. — [examples/docs](https://github.com/rivet-dev/agents/tree/main/examples/docs)

**ambionframework/ambion** (★12, created 2026-08-25, "Status: 0.x"; `@ambionframework/pi` depends on `@earendil-works/pi-durable` 1.0.4) — [repo](https://github.com/ambionframework/ambion); [packages/pi/package.json](https://github.com/ambionframework/ambion/blob/main/packages/pi/package.json)
- A "collaboration kernel for agents and humans". "A room is a shared journal with rules for taking part." Agents read in parallel, speak or stay silent, and can open breakout rooms. — [README](https://github.com/ambionframework/ambion/blob/main/README.md)
- "One team on three harnesses": one room seats Pi, Claude Agent SDK and Codex executors that share one tool set. Seats default to `broadcast` attention. — [README](https://github.com/ambionframework/ambion/blob/main/README.md)

**fabric-runtime/pi-fabric** (★290; npm `pi-fabric` 0.117.1) — [repo](https://github.com/fabric-runtime/pi-fabric)
- "One program for tools, MCP, agents, workflows, actors, mesh, councils, and recursion." Offers one-shot workers, durable resident agents, persistent actors, councils, and a "mesh" of "durable topics, shared tasks, and compare-and-swap state". There is a `fabric-swarm` skill for "a durable team coordinating through versioned tasks". — [README](https://github.com/fabric-runtime/pi-fabric/blob/main/README.md)
- `agents.runner` defaults to `pi-durable`: an isolated Pi SDK process with a `DurableAgent` backed by the durable Harness. — [docs/durable-pi.md](https://github.com/fabric-runtime/pi-fabric/blob/main/docs/durable-pi.md)
- With `residency: "durable"`, ownership moves to a hidden resident host and the owner is published in a participant directory. "Other trusted sessions in the project can call `ask`, `tell`, `steer`, `followUp`, and `stop`; Fabric routes each call to that owner." There is also a background completion inbox whose "undelivered envelopes survive disconnects", and a supervised-fork pattern that pairs a mailbox actor with a branch-seeded worker. — [docs/agents.md](https://github.com/fabric-runtime/pi-fabric/blob/main/docs/agents.md)
- Note: pi-fabric is a coding-agent extension that *uses* Pi Durable for its child runner. That makes it a hybrid of questions 2 and 3.

**TerseAI/durable-actors** (★223, created 2026-08-30) — [repo](https://github.com/TerseAI/durable-actors)
- An open-source alternative to Cloudflare Durable Objects for "real-time, multi-agent coordinated systems". Actors have persisted state, serialized execution and WebSocket broadcast. — [README](https://github.com/TerseAI/durable-actors/blob/main/README.md)
- `@durable-actors/pi-durable` runs a Pi Durable agent inside an actor ("The actor owns the database; the adapter owns the Pi harness and conversation") and exposes `agent.harness` for extra conversations and tasks. Its quickstart is a shared multiplayer team chat, not agent-to-agent messaging. — [packages/pi-durable/README.md](https://github.com/TerseAI/durable-actors/blob/main/packages/pi-durable/README.md)

**cloudflare/agents** (★5,838) — [repo](https://github.com/cloudflare/agents)
- Ships a `PiHarness` (`agents/harness/pi`). The Cloudflare changelog dated 2026-10-02 announces a Pi harness. — [packages/agents/src/harness/pi](https://github.com/cloudflare/agents/tree/main/packages/agents/src/harness/pi); [cloudflare-docs changelog](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/changelog/agents/2026-10-02-pi-harness.mdx)
- The `examples/next/channels` example serves pi-durable sessions to browsers and terminals through a `ChannelGateway` over WebSocket. It is multi-participant (several humans per room), not agent-to-agent. — [channels README](https://github.com/cloudflare/agents/blob/main/examples/next/channels/README.md)

**botiverse/oar** (★197, "Open Agent Runtime: programming interface for all agent harnesses") — [repo](https://github.com/botiverse/oar)
- Supports Pi Durable 1.2.0 over a host-owned Harness, using `watchEvents`. — [docs/runtimes/pi-durable.md](https://github.com/botiverse/oar/blob/main/docs/runtimes/pi-durable.md)
- `createSubagents({ maxRunning })` and `crew.spawn({ runtime: "codex" | "pi", task })` hand work to other runtimes; "each report wakes the session". Per its README, `mcpServers` cannot attach to Pi Durable sessions. — [README](https://github.com/botiverse/oar/blob/main/README.md)

**Nyarlathoteppppp/pi-durabletask-mcp** (★8, created 2026-10-03; npm 0.7.8) — [repo](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp)
- An MCP server that lets Claude Code or Codex hand reviews to Pi agents on other providers. Tools include `spawn_batch` and `wait`, plus steer and follow-up. Opt-in durable tasks survive restarts. CI covers Pi 1.0.0, 1.0.4 and 1.1.0. — [README](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/blob/main/README.md); [discussion #10447](https://github.com/earendil-works/pi/discussions/10447)

**AltanS/collie** (★1,356; a mobile PWA client for Herdr) — [repo](https://github.com/AltanS/collie)
- The `examples/durable-member` example exposes a Pi Durable program's conversations over a Unix "durable socket wire". A Collie peer with `COLLIE_MUX=durable` shows them as panes. The wire "is experimental and may change in any minor release". — [examples/durable-member](https://github.com/AltanS/collie/blob/main/examples/durable-member/README.md)
- Several Collie instances relate as lead and peers over a "crew link" (`CREW_PROTOCOL.md`). This is device and multiplexer federation, not model-to-model messaging. — [README](https://github.com/AltanS/collie/blob/main/README.md)

**thruwire/foreman** (★764) — [repo](https://github.com/thruwire/foreman)
- An "agent supervisor and software factory foreman". It has bridges that forward Pi events and Pi Durable task hooks (pinned to pi-durable 1.0.4) to a supervisor that assesses workers. — [integrations/pi/README.md](https://github.com/thruwire/foreman/blob/main/integrations/pi/README.md)

**heyhuynhgiabuu/pi-task** (★62) — [README](https://github.com/heyhuynhgiabuu/pi-task/blob/main/README.md)
- A coding-agent `task` subagent extension with tmux, Herdr and SDK backends, plus "an experimental SQLite-backed durable backend" that resumes opted-in tasks after a parent restart.
- A `conversation_id` maps to a durable subagent run that can be reused for specialist memory.

**Other dependents seen, with no inter-agent messaging in their READMEs**
- lucasmeijer/AgentsInTheCloud (★156) has a `packages/subagents` package, but no README for it. — [repo](https://github.com/lucasmeijer/AgentsInTheCloud)
- Parcha-ai/agentrun (★239) is a workflow DSL with `@parcha/pi-durable-disk` ("one owner per run, a fence, a supervisor"). — [README](https://github.com/Parcha-ai/agentrun/blob/main/README.md)
- joelhooks/rat-king (★37) is an "encrypted, AT Protocol agent network", pre-alpha, with mailbox and relay vocabulary but "No network or deploy automation runs yet". — [README](https://github.com/joelhooks/rat-king/blob/main/README.md)
- getlarge/themoltnet (★18) is an agent-work control plane reachable via REST, MCP, CLI or SDK. — [README](https://github.com/getlarge/themoltnet/blob/main/README.md)
- Hosts and UIs: finnvoor/PiDurableKit (★257), bubbleptr/pinomad (★29), huang-sh/PiX (★197), acoyfellow/coil (★27), SawyerHood/do-computer (★16). — repos per the code search above.

### Inferences
- Four inter-agent patterns recur on Pi Durable:
  1. **Owned child conversation**: a tool creates and awaits a task-owned conversation (Durable examples 22 and 23; rivet subagents; pi-agents helpers).
  2. **Fire-and-forget submit into another agent's durable inbox**: rivet's `requestReview`, pi-agents' `agent_send`, Durable example 23's reporter task. Dedup comes from `requestId` and identity binding.
  3. **Shared journal or room**: Ambion.
  4. **Mesh/actor layer with topics, mailboxes and CAS state**: pi-fabric, Durable Actors, Rivet.
- Because Durable storage is single-process-owned, every cross-process or cross-machine design puts a host layer in front: Rivet actors, Durable Actors, Durable Objects, a Unix socket (Collie) or a resident host (pi-fabric). None of them shares one Durable store between processes.
- pi-agents' messaging guarantees are the most precisely specified inter-agent contract in the ecosystem and are worth reusing as a reference. Its roadmap item "across Pi sessions through a broker" is still open territory.
- Maturity is low across the board. Most repos are under 2 months old, and many pin exact pi-durable versions (1.0.4, 1.2.0) because the API is still shifting (for example, the `content`→`output` rename in #10815).

### Gaps
- I did not get npm's "dependents" list for `@earendil-works/pi-durable` (no npm CLI command for it), and GitHub's dependency-graph dependents page was not fetched. Private or non-default-branch users are invisible.
- I did not read code to confirm how each project wires communication internally. The descriptions come from READMEs and docs.
- The rivet `coder.ts` example returns `{ content: [...] }` from a pi-durable tool. Durable 1.x renamed tool results to `output` (#10815), so this example may be stale; not verified.

## 3. Pi coding-agent extensions for subagents and multi-agent work: patterns, and whether any run on Pi Durable

### Takeaway
The coding-agent ecosystem is large and busy. pi-subagents alone has ★3.9k, and there are many forks and alternatives. It uses five transport patterns: in-process sessions, child `pi` processes (`--mode json`, `-p`, RPC), terminal multiplexer panes (tmux, Herdr, cmux, zellij, WezTerm), file-based mailboxes and task lists, and small local brokers (IPC or TCP). Almost none of these extensions depend on pi-durable. The exceptions are pi-fabric (pi-durable is its default child runner) and pi-task (experimental durable backend). Several advertise their own durability, through JSONL transcripts or SQLite, instead.

### Cited Findings
**Subagent delegation**
- nicobailon/pi-subagents (★3,936; npm `pi-subagents` 0.78.0): foreground children run "as sessions inside the parent Pi process". Background children run in "a detached runner process". It has a FleetView, steering, and an extension RPC/delegation API. — [README](https://github.com/nicobailon/pi-subagents/blob/main/README.md); background children needed `@earendil-works/pi-server` / `pi-client` per [#9218](https://github.com/earendil-works/pi/issues/9218)
- tintinweb/pi-subagents (★1,312) offers "Claude Code-style" `Agent`, `get_subagent_result` and `steer_subagent` tools, plus `@agent` mentions that address a subagent directly. — [README](https://github.com/tintinweb/pi-subagents/blob/main/README.md)
  - Nested subagents are depth-capped (default 2).
  - Lifecycle events go out on `pi.events` (`subagents:created`, `completed`, `steered`, ...).
  - "Cross-extension RPC" over the in-process event bus: `subagents:rpc:spawn`, `stop`, `steer`, `consume`.
- edxeth/pi-subagents (★132) is a fork of HazAT/pi-interactive-subagents (★717). Interactive children open as panes in Herdr, cmux, tmux, zellij or WezTerm; background children are `pi -p` processes. It adds child-to-parent messaging and forked context. — [edxeth README](https://github.com/edxeth/pi-subagents/blob/main/README.md); [HazAT repo](https://github.com/HazAT/pi-interactive-subagents)
- boadij/pi-herdsman (★192, created 2026-09-07) is "the orchestration layer between Pi and herdr": Pi owns the conversation, and Herdr owns processes, panes and worktrees. — [README](https://github.com/boadij/pi-herdsman/blob/main/README.md)
- npm shows many other variants: `@gotgenes/pi-subagents` (in-process core with lifecycle events), `@henryqw/pi-subagent` ("durable checked isolated task graphs"), `@arhen/pi-core-subagent` (dependency-graph scheduler), `pi-subagent-manager`, `pi-herdr-agents`, `@agwab/pi-workflow`, and `@alexeiled/pi-subagents-bridge` (adapts `@tintinweb/pi-tasks` to nicobailon/pi-subagents). None declares a dependency on pi-durable. — [npm search "pi-subagents"](https://www.npmjs.com/search?q=pi-subagents)

**Peer messaging and teams**
- nicobailon/pi-messenger (★720) is a chat room for agents "in different terminals sharing a folder" — [README](https://github.com/nicobailon/pi-messenger/blob/main/README.md):
  - Agents join, see presence, claim tasks, reserve files and send messages.
  - Incoming messages wake the recipient via `pi.sendMessage()` with `triggerTurn: true, deliverAs: "steer"`.
  - File reservations are enforced by blocking tool calls.
  - "All coordination is file-based, no daemon required." State lives in `~/.pi/agent/messenger/` and `.pi/messenger/`.
  - Crew workers are `pi --mode json` subprocesses.
- monotykamary/pi-messenger-swarm (★40) is a "swarm-first" fork with channels and file-based coordination. — [README](https://github.com/monotykamary/pi-messenger-swarm/blob/main/README.md)
- nicobailon/pi-intercom (★537) does 1:1 messaging between Pi sessions on one machine through "a tiny local broker over a local IPC transport". It gives pi-subagents children a `contact_supervisor` tool, with `reason: "need_decision"` for blocking clarification. — [README](https://github.com/nicobailon/pi-intercom/blob/main/README.md)
- tmustier/pi-agent-teams (★110, MVP) brings Claude Code agent teams to Pi — [README](https://github.com/tmustier/pi-agent-teams/blob/main/README.md):
  - A shared task list kept as one file per task, with dependencies and auto-claim.
  - `message_dm` / `message_broadcast` through "file-based mailboxes"; `urgent=true` steers the recipient.
  - `message_steer` over RPC to teammates.
  - A mailbox handshake for shutdown.
- agent-chat (Hysilens-Helektra) is localhost TCP peer-to-peer messaging with no orchestrator. — [discussion #10069](https://github.com/earendil-works/pi/discussions/10069)
- kings0527/pi-harness (★8) has a topic-based shared blackboard `board` tool (`open`/`post`/`read --since`/`close`) and `spawn` role cards (scout, worker, reviewer, advocate, critic), driving children through `pi --print`. — [README](https://github.com/kings0527/pi-harness/blob/main/README.md)
- Cross-harness team tools that include Pi:
  - mvschwarz/openrig (★7,518): YAML-defined persistent teams of Claude Code, Codex and Pi on tmux. — [README](https://github.com/mvschwarz/openrig/blob/main/README.md)
  - firstintent/ccteam (★654): "identity, routing, delivery guarantees, guardrails, a cost ledger" across Claude Code, Codex, Pi and others. — [README](https://github.com/firstintent/ccteam/blob/main/README.md)
  - modem-dev/baudbot (★214): a multiplayer Slack assistant built on Pi. — [repo](https://github.com/modem-dev/baudbot)
- npm packages that do multi-machine work or join open networks:
  - `@yiki21/pi-agent-team`: "several machines running the Pi coding agent into one team over your tailnet", with broker, mesh and SWIM transports. — [npm](https://www.npmjs.com/package/@yiki21/pi-agent-team)
  - `@awebai/pi`: messages and teams "on an open network". — [npm](https://www.npmjs.com/package/@awebai/pi)
  - `@deepseek-ai/dsh-experimental-agent-team`: "durable peer mailbox, and shared task DAG" for DeepSeek Harness. — [npm](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-agent-team)

**Pi Durable usage among extensions**
- No README of pi-subagents (both), pi-messenger, pi-intercom, pi-agent-teams, pi-herdsman, openrig or ccteam mentions pi-durable. Their npm dependency fields do not include it. — [npm pi-subagents](https://www.npmjs.com/package/pi-subagents); [npm pi-messenger](https://www.npmjs.com/package/pi-messenger)
- Exceptions:
  - pi-fabric's default `pi-durable` runner. — [docs/durable-pi.md](https://github.com/fabric-runtime/pi-fabric/blob/main/docs/durable-pi.md)
  - pi-task's experimental SQLite durable backend. — [README](https://github.com/heyhuynhgiabuu/pi-task/blob/main/README.md)
  - pi-agents, which is a coding-agent extension that hosts agents on pi-durable internally. — [README](https://github.com/mavam/pi-agents/blob/main/README.md)

### Inferences
- In the coding-agent world, the delivery primitive almost everyone uses is "inject as a steering or follow-up user message into the recipient session" (`pi.sendMessage` with `deliverAs: "steer"`/`triggerTurn`). Durability is ad hoc: JSONL transcripts, files on disk, local SQLite.
- File-based mailboxes plus shared task files (pi-messenger, pi-agent-teams) are the most common way to coordinate peers without a daemon. Local brokers (pi-intercom IPC, agent-chat TCP) are next.
- Moving extension-based roles to Durable is blocked by #10386 (no extension hosting) and #10837 (no MCP). This explains why the big subagent extensions have not moved to Durable, and why pi-agents must restrict its durable agents to built-in tools.
- Known failure modes for anyone designing on the coding agent: messages from the main thread get misrouted into subagent turns (#10610); undeclared server and client deps break background children (#9218); `sendMessage()` gives no persistence acknowledgement for exactly-once delivery (#8023).

### Gaps
- I did not verify the maturity claims (tests, real usage) of most extensions beyond stars and dates.
- I did not read pi-subagents' extension RPC docs or pi-intercom's broker protocol in detail.

## 4. Adapters bridging Pi / Pi Durable to A2A, MCP or message buses

### Takeaway
Several small, low-adoption A2A extensions exist for the Pi *coding agent* (all ★0–11). None targets Pi Durable specifically, and none has maintainer recognition. MCP bridges are more mature: the official `@earendil-works/pi-mcp` client, `pi-mcp-adapter`, pi-fabric's MCP routing, and pi-durabletask-mcp, which exposes Pi as an MCP delegate. But MCP *inside* Pi Durable is not yet supported upstream (#10837 was auto-closed). Message-bus integrations are third-party: the agent-event-bus RFC (rejected), Durable Actors and Rivet actors, and pi-fabric's mesh.

### Cited Findings
**A2A (Google Agent2Agent) adapters, all for the coding agent**
- DrOlu/pi-a2a-communication (★11, created 2026-03-15, single push): "Enterprise-grade A2A protocol implementation". Agent Card discovery (`.well-known/agent-card`), Pi exposed as an A2A server, parallel and chained tasks. — [README](https://github.com/DrOlu/pi-a2a-communication/blob/main/README.md)
- ww2521/pi-a2a-adaptor (★6, 2026-06): an A2A *client* for Pi that is "fully compatible with fasta2a". It covers Agent Card discovery, Nacos A2A Registry, the LiteLLM Agent Gateway, SSE `message/stream` and push notifications. — [README](https://github.com/ww2521/pi-a2a-adaptor/blob/main/README.md)
- imkingjh999/pi-a2a (★2, 2026-07): a "decentralized LAN P2P" A2A message bus. mDNS discovery, and each agent is both an A2A v1.0 JSON-RPC server and client, with threaded replies, an inbox, unread tracking and presence. — [README](https://github.com/imkingjh999/pi-a2a/blob/main/README.md)
- `@bacnh85/pi-a2a` (npm 0.8.0, created 2026-08-13): "A2A Protocol v1.0 bidirectional extension for the Pi coding agent — distribute tasks to remote agents, be called by them, and self-declare for local session discovery". Source in bacnh85/pi-extensions. — [npm](https://www.npmjs.com/package/@bacnh85/pi-a2a); [repo path](https://github.com/bacnh85/pi-extensions/tree/main/pi-a2a)
- smorand/pi-a2a (★0, 2026-08-07): "Pi A2A server extension — exposes pi agents over the Agent-to-Agent protocol (A2A v1.0)". No readable README. — [repo](https://github.com/smorand/pi-a2a)
- tdk67/pi_a2a_setup (★1): "Agent to agent communication between PI agents". — [repo](https://github.com/tdk67/pi_a2a_setup)

**MCP bridges**
- The official `@earendil-works/pi-mcp` (1.3.0) is a "Standalone Model Context Protocol client for pi and other applications". The community `pi-mcp-adapter` (5.3.1) and `pi-mcp-extension` (1.5.1) are coding-agent extensions. — [npm pi-mcp](https://www.npmjs.com/package/@earendil-works/pi-mcp); [npm pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter)
- Pi Durable has no shipped MCP extension. #10837 proposed one (2026-10-12), but it was auto-closed. pi-agents and oar both document that MCP does not work for durable agents. The Durable README names "an MCP bridge" only as an example caller of `executeTool()`. — [#10837](https://github.com/earendil-works/pi/issues/10837); [pi-agents README](https://github.com/mavam/pi-agents/blob/main/README.md); [oar README](https://github.com/botiverse/oar/blob/main/README.md); [Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- pi-durabletask-mcp is the reverse direction: an MCP server through which Claude Code or Codex delegate to Pi (optionally durable) workers. — [repo](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp)
- The agent-event-bus RFC (#2714/#2715) would have linked Pi sessions to a Python FastMCP event-bus server shared with Claude Code. It was rejected and the author banned. — [#2715](https://github.com/earendil-works/pi/issues/2715)

**Message buses and actor substrates around Pi Durable**
- Rivet Actors, with actor RPC between agent actors. — [rivet agent-to-agent](https://github.com/rivet-dev/agents/blob/main/docs/content/docs/agent-to-agent.mdx)
- Durable Actors (WebSocket broadcast, serialized execution). — [TerseAI/durable-actors](https://github.com/TerseAI/durable-actors)
- Cloudflare Durable Objects and Channels. — [cloudflare/agents channels](https://github.com/cloudflare/agents/blob/main/examples/next/channels/README.md)
- pi-fabric mesh (durable topics, mailboxes, CAS state). — [pi-fabric docs/agents.md](https://github.com/fabric-runtime/pi-fabric/blob/main/docs/agents.md)
- tonbo-io/ursula (★332), a "Distributed event stream server over HTTP, backed by S3", has a `clients/sqlite-ursula` package that references pi-durable. Its role there was not examined. — [repo](https://github.com/tonbo-io/ursula)

### Inferences
- A2A support for Pi exists only as small single-author experiments on the coding agent. Nothing production-grade is visible, and none of it is built on Pi Durable. A Durable-native A2A adapter (Agent Card plus JSON-RPC in front of `conversation.submit()` with `requestId` = A2A task id) seems to be an unfilled niche.
- For Durable, the practical "bus" today is whatever hosts the Harness: an actor framework, a Durable Object, or a socket. Agents address each other by actor key or conversation id and use `submit()` for delivery.

### Gaps
- I did not check whether any A2A extension is maintained or tested beyond the README. DrOlu's repo shows a single push date, which suggests it was abandoned.
- I found no evidence of a NATS, Redis, Kafka or other generic message-queue adapter for Pi or Pi Durable. GitHub repo search turned up none, but code search for those terms combined with pi-durable was not run.
- I did not determine ursula's integration with pi-durable.
