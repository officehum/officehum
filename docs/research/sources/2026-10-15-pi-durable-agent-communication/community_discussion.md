# Community discussion of Pi Durable and multi-agent communication (HN, Reddit, YouTube, X, blogs)

Scope note: the user's term "PyDurable" turned up nowhere. The product is "Pi Durable", npm `@earendil-works/pi-durable`, announced 2026-10-01 alongside Pi 1.0. Below, "Pi Durable" means that package. "pi" or "Pi" means Mario Zechner's terminal coding agent (pi-coding-agent / pi-agent-core), which is older. Research ran on 2026-10-15, two weeks after launch, so community material is thin and recent.

## Hacker News: what commenters and the authors said about multi-agent communication

### Takeaway
The main HN thread on Pi Durable was well received (515 points). Multi-agent communication is a minor topic in it. The authors (badlogic = Mario Zechner, the_mitsuhiko = Armin Ronacher) mostly answered questions about state, forking/parenting, idempotency and sandboxing. Commenters raised multi-agent topics: coordinating several pi instances, trust-tiered sub-agents, and "agents as microservices." Nobody discussed a dedicated agent-to-agent protocol.

### Cited Findings
- Main thread: "Pi Durable" (earendil.com/posts/pi-durable), submitted 2026-10-01 by paulsmith, 515 points, 77 comments (HN item 49925969). The companion "Pi 1.0" thread had 1689 points and 609 comments (item 49926069). — [HN Algolia search "pi-durable"](https://hn.algolia.com/api/v1/search?query=pi-durable); [HN thread](https://news.ycombinator.com/item?id=49925969). An aggregator lists 67 comments ([zeli.app](https://zeli.app/story/49925969)), probably an earlier snapshot.
- badlogic (2026-10-02, id 49931767) on forking: "A conversation can be parented to an entry in another conversation". He presents this as a fix: "In Pi Durable, we corrected this mistake." This is the parent/child conversation relationship that subagents build on. — [HN item 49925969](https://news.ycombinator.com/item?id=49925969)
- badlogic (2026-10-02, id 49931784) rejects a comparison to Gastown (a multi-agent orchestrator): "I do not see any resemblence to Gastown at all?" He adds that "Within a session, you can give each conversation its own sandbox". — [HN thread](https://news.ycombinator.com/item?id=49925969)
- badlogic (2026-10-01, id 49927546) says external sync/messaging is done with durable tasks: a commit "durably schedules a task that then syncs it to postgres". He also says "What's missing here is sugar", meaning a per-commit hook. — [HN thread](https://news.ycombinator.com/item?id=49925969)
- badlogic (id 49927329) on shared-state design: "JSON patch can't deal with the kinds of data we encounter". the_mitsuhiko (id 49927163): "We tried so many things", and "a reasonable line to draw". — [HN thread](https://news.ycombinator.com/item?id=49925969)
- badlogic (id 49931801): "requestId is an imdempotency key", i.e. exactly-once message submission into a conversation. — [HN thread](https://news.ycombinator.com/item?id=49925969)
- the_mitsuhiko (2026-10-02, id 49935099), on how agent state on VMs/sandboxes stays consistent: "That greatly depends on your agent design." — [HN thread](https://news.ycombinator.com/item?id=49925969)
- Practitioner comments touching multi-agent:
  - ernsheong: "trying to build a harness coordinating multiple instances of vanilla pi". — [HN thread](https://news.ycombinator.com/item?id=49925969)
  - zmmmmm: "you need a higher level agent that can spin up a low trust sub-agent". — [HN thread](https://news.ycombinator.com/item?id=49925969)
  - imtringued (id 49931755): "Some people want to run agents as if they are microservices", and mentions needing "100 different agent types". — [HN Algolia](https://hn.algolia.com/api/v1/search?query=pi-durable)
  - lemming notes Durable "doesn't support branching conversation trees, it only supports conversation forks" with ancestry. — [HN thread](https://news.ycombinator.com/item?id=49925969)
  - azuanrb mentions using DBOS for durable execution as an alternative. — [HN thread](https://news.ycombinator.com/item?id=49925969)
- Other comments: aquariusDue calls Pi "the Neovim of harnesses". antonok calls Earendil's Gondolin "the best sandboxing model I've found so far". — [HN Algolia "earendil"](https://hn.algolia.com/api/v1/search?query=earendil)
- Small follow-on Show HNs, all with almost no discussion:
  - "Show HN: Pi Durable and Nostr" (jonstaab, 2026-10-02, 3 pts, 0 comments)
  - "Pi Durable, as Statecharts" (2026-10-03, 2 pts)
  - "Pi Pocket: Mobile-First Web App for Pi Durable Agents" (2026-10-13, 2 pts)
  - A link to the X video "Mario and Armin on Why Pi Durable" (2026-10-05, 1 pt)
  - — [HN Algolia "pi-durable"](https://hn.algolia.com/api/v1/search?query=pi-durable)
- Earlier context: "Mario and Earendil" (Armin's blog, 2026-04-08, 68 pts, 40 comments) covers Earendil acquiring Pi / hiring Mario. — [HN Algolia "earendil"](https://hn.algolia.com/api/v1/search?query=earendil)
- One unrelated multi-agent comment in the search results: ramoz (2026-10-09, Plannotator Inbox thread): "While all your agents work they constantly bombard you with decisions". — [HN Algolia](https://hn.algolia.com/api/v1/search?query=pi-durable)

### Inferences
- On HN, the authors present multi-agent support in Pi Durable as structural: owned or parented conversations, durable tasks, idempotent submissions, and a sandbox per conversation. They do not present it as a messaging protocol. Commenters who want orchestration (coordinating pi instances, trust tiers) are describing things they would build on top.
- Rejecting the Gastown comparison suggests the authors don't see Pi Durable as a swarm or orchestrator product.

### Gaps
- I did not read every comment in the 77-comment thread. Excerpts came from a summarizing fetch of the Algolia items API, so a short multi-agent exchange may be missing.
- No HN thread found specifically about pi subagents (pre-Durable) beyond the comments above. I did not run the "pi coding agent subagent" query separately on Algolia.

## Reddit: posts about Pi Durable or pi multi-agent setups

### Takeaway
I found no Reddit evidence. reddit.com blocked fetching, and two web searches (including extended mode) returned no Reddit threads about Pi Durable or pi subagents.

### Cited Findings
- WebFetch of `reddit.com/search.json` failed: "unable to fetch from www.reddit.com". (Tool error, no URL to cite.)
- An extended web search for Reddit and "pi durable" returned only HN, DEV Community, Cloudflare docs, Earendil and news sites. Closest community writing: a DEV post arguing that durability guarantees "state survives", not that the agent behaves. — [DEV Community, Dishant Sharma, 2026-10-10](https://dev.to/dishant0406/pi-durable-shipped-then-the-hype-took-over-the-timeline-4k3p)
- The same DEV post repeats that core pi ships "No sub-agents". It says a harness "runs one or more agent conversations in parallel" and that storage has one owning process while other clients attach. — [DEV Community](https://dev.to/dishant0406/pi-durable-shipped-then-the-hype-took-over-the-timeline-4k3p)

### Inferences
- Practitioner pi multi-agent work seems to show up as packages on pi.dev and GitHub repos (see YouTube/X and blog sections) rather than Reddit threads. This may be an artifact of search coverage.

### Gaps
- Reddit could not be checked directly: r/LocalLLaMA, r/ClaudeAI, r/AI_Agents and r/LLMDevs were not searchable with these tools. Treat "no Reddit discussion found" as unverified, not as evidence of absence.

## YouTube: talks, demos and tutorials

### Takeaway
Four relevant videos came up, all from early-to-mid October 2026. One is an author talk (Zechner and Ronacher). The most multi-agent one is IndyDevDan/disler's "Pi Durable PROACTIVE Agents", whose companion repo is an "agent network" where agents hand facts to each other through shared app state, not direct messaging.

### Cited Findings
- "Pi Durable: Agents That Survive Crashes — Mario Zechner & Armin Ronacher": the authors explaining Pi Durable. The search tool said "about 8 days ago" (roughly 2026-10-07). I could not retrieve the channel, description or chapters. — [YouTube ja_7AF54OtE](https://www.youtube.com/watch?v=ja_7AF54OtE)
- "Pi Durable PROACTIVE Agents: Jev Triggers My ON-CALL Pi Agent", roughly 2026-10-12 (search said "about 3 days ago"). In the demo, a classifier watches a production log stream and triggers an on-call Pi agent. It links to the disler/durable-pi repo. — [YouTube DNDYYHsypZg](https://www.youtube.com/watch?v=DNDYYHsypZg)
- How the disler/durable-pi repo ("agent network", 146 stars, 50 forks) handles agent communication:
  - Every agent and session on a device shares one JSON "App State" through `read_state`/`update_state`. Updates are atomic path ops, and a stale save gets a `409 conflict`. The README says to "Use it to hand facts between agents."
  - It also supports subagents (a `release-check` job spawns one to gather evidence), forks, addressing by id/name (`/v1/sessions/<name>/agents/main`), and `requestId` idempotency.
  - A laptop hub proxies REST/SSE to per-device backends; "The hub holds every token."
  - It documents no direct agent-to-agent message protocol.
  - — [GitHub disler/durable-pi](https://github.com/disler/durable-pi)
- "Pi 2.0 (Codemode, Durable Tools & More!)", roughly 2026-10-04, covers the Pi release with Codemode/MCP and Pi Durable. The "2.0" in the title doesn't match Earendil's "Pi 1.0" naming; it may be the creator's own label. — [YouTube BukNA_W1e3Y](https://www.youtube.com/watch?v=BukNA_W1e3Y); [daily.dev](https://daily.dev/posts/pi-2-0-codemode-durable-tools-more-native-via-codemode-custom-model-routing-pi-durable-z0xbq3trl)
- "Pi Durable on Cloudflare", roughly 2026-10-01, a short demo described as "Christian" showing Pi Durable on Cloudflare. — [YouTube y0lykS_IIt4](https://www.youtube.com/watch?v=y0lykS_IIt4)
- Related earlier talk: an AI Engineer talk page for the pi coding agent. Per secondary coverage, Mario criticizes Claude Code and OpenCode for buggy features, uncontrolled context management and limited extensibility. — [ai.engineer](https://ai.engineer/talks/pi-coding-agent)

### Inferences
- The clearest community pattern for "agents talking to each other" on Pi Durable so far is shared durable state plus subagents and forks, coordinated through a hub, rather than peer messaging.

### Gaps
- Upload dates are approximate: they come from the search tool's relative "N days ago", not from YouTube pages, which returned no metadata.
- I could not get video transcripts, so I can't say what the authors said on camera about subagents, multiplayer or Temporal.

## X/Twitter: posts by @mitsuhiko, @badlogicgames, @pidotdev and users

### Takeaway
X blocks direct fetching (HTTP 402), so these findings come from search snippets only. Mario has said for a while that pi deliberately leaves subagents out of core. After Durable launched, he built a personal "multiplayer" phone agent on Pi Durable "with subagents" to test it. The official @pidotdev account frames Durable as a task-based workflow engine for "long-running, multiplayer agents" and addresses "why not Temporal or Effect.ts."

### Cited Findings
- @pidotdev, "Monday Meditations": @badlogicgames and @mitsuhiko talk about "why we built Pi Durable, a harness build around a small task-based workflow engine so long-running, multiplayer agents can suspend and resume anywhere. Also: why not Temporal or Effect.ts." Submitted to HN 2026-10-05. — [X @pidotdev/status/2107033061905104941](https://x.com/pidotdev/status/2107033061905104941); [HN Algolia](https://hn.algolia.com/api/v1/search?query=pi-durable)
- @badlogicgames (~2026-10-03 per search summary): replacing Claude for Android with "a little pi durable thing that runs fully on my phone… and it has subagents". He calls it "not an official earendil product, just a personal project to battle test durable". — [X badlogicgames/status/2106286641551675411](https://x.com/badlogicgames/status/2106286641551675411)
- @badlogicgames follow-up: it runs on the phone with "no cloud vm", "Its multiplayer", any provider/model, artifacts added, and "There is no moat." — [X badlogicgames/status/2106452296087302173](https://x.com/badlogicgames/status/2106452296087302173)
- @badlogicgames (Feb 2026, from the search snippet): "and now you know why pi doesn't have subagents built-in." The direct fetch failed with 402, so the context of what he was replying to is unknown. — [X badlogicgames/status/2020466594497908792](https://x.com/badlogicgames/status/2020466594497908792)
- @badlogicgames pointed to a write-up "on what Pi Durable is all about… With code examples." The link target is a t.co URL I could not resolve, possibly the Earendil post. — [X badlogicgames/status/2105739632168054992](https://x.com/badlogicgames/status/2105739632168054992)

### Inferences
- In this material, "multiplayer" (several humans or clients steering one agent) gets more emphasis from the authors than agent-to-agent communication.

### Gaps
- I found no @mitsuhiko post specifically on subagents or inter-agent communication. No @earendil account posts surfaced.
- None of the X posts were read in full. Quotes come from search-result titles and snippets only.

## Blogs: the authors' stated views on subagents, context isolation, durability and agent protocols

### Takeaway
Mario Zechner (Nov 2025) is openly skeptical of in-session subagents: a "black box within a black box". He calls parallel feature subagents "an anti-pattern", and prefers observable separate pi processes (bash/tmux) with artifacts handed between sessions. Armin Ronacher (Nov 2025) supports subagents mainly for failure isolation, reporting back only success plus a brief note on what failed, with a shared filesystem-like layer as the coordination substrate. Pi Durable (Oct 2026) turns this into owned child conversations, durable tasks and versioned shared documents. The official post is thin on agent-to-agent messaging and says nothing about A2A.

### Cited Findings
- Mario, "What I learned building an opinionated and minimal coding agent" (2025-11-30):
  - Subagents are "a black box within a black box", and "you have zero visibility into what that sub-agent does". — [mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
  - "Using a sub-agent mid-session for context gathering is a sign you didn't plan ahead." Instead, gather context in a separate session, save it as an artifact, and start fresh. — [mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
  - Running parallel subagents on features is "an anti-pattern in my book and doesn't work". — [mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
  - If you need one, "just ask it to run itself via bash", ideally in tmux "for full observability and the ability to interact with that sub-agent directly". He still sees value for code review, and adds "we trust our agents too much". — [mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- Armin, "Agent Design Is Still Hard" (2025-11-21):
  - Run iterative work "in a subagent until they succeed and only report back the success", plus "a brief summary of approaches that did not work". — [lucumr.pocoo.org](https://lucumr.pocoo.org/2025/11/21/agents-are-hard/)
  - Shared state via a file-system-like layer is "an important building block", so tools such as ExecuteCode and RunInference share files. Avoid "dead ends" where only one tool can consume an output. — [lucumr.pocoo.org](https://lucumr.pocoo.org/2025/11/21/agents-are-hard/); summarized by [Simon Willison](https://simonwillison.net/2025/Nov/23/agent-design-is-still-hard/)
- Armin, "Pi: The Minimal Agent Within OpenClaw" (2026-01-31): pi sessions are trees. His `/review` flow branches into a fresh review context and brings fixes back, which works as subagent-like delegation via branching. — [lucumr.pocoo.org/2026/1/31/pi](https://lucumr.pocoo.org/2026/1/31/pi/)
- Earendil, "Pi Durable" (2026-10-01, byline "Earendil Engineering"):
  - "A subagent runs in a conversation of its own", created by a tool that owns it. It survives crashes and tracks its own cost.
  - Ownership decides abort scope ("Aborting a task aborts what it owns, bottom-up"). Ownerless conversations, such as a Slack thread, are not stopped with a parent.
  - Tools can talk to other conversations through the harness API. Work reaches a conversation through submissions (queued or steering) with exactly-once `requestId`.
  - Typed JSON documents are committed atomically with the transcript, with per-document fork semantics.
  - "Any client can steer a running conversation."
  - No inbox or agent-to-agent protocol is described.
  - — [earendil.com/posts/pi-durable](https://earendil.com/posts/pi-durable/)
- Cloudflare's PiHarness docs (updated 2026-10-12):
  - Recommends "one Durable Object per conversation".
  - Exposes `sessions.create()`, `sessions.fork(id)` and `sessions.list()`; the list includes sessions created by Pi's subagent tools.
  - Says nothing about agent-to-agent calls or whether multiple clients can share one stream.
  - — [Cloudflare Agents docs](https://developers.cloudflare.com/agents/harnesses/pi/)
- Community packages, the practical multi-agent layer:
  - **pi-subagent** (badlogic GitHub, 224 stars): each child runs in its own tmux session plus a JSONL session. Commands include `subagent send` (steer or `--follow-up`) and `subagent wait` for durable results. Nested subagents are disabled. Children are suspended when the parent quits and relaunched idle on resume. — [GitHub badlogic/pi-subagent](https://github.com/badlogic/pi-subagent)
  - **pi-durable-subagents** (by purboo, v1.0.42, ~5k/week): "Subagents that never lose work, and never do it twice." A single `subagents` tool handles start, status and messages. Children can ask the parent questions (answered with `send answer`). The parent can `steer`, `notify` or `follow-up`. Workflows chain results with `{previous}`. There is no subagent-to-subagent messaging. The page shows a publish date of Oct 16, 2026, which is after today; probably a timezone or listing artifact. — [pi.dev/packages/pi-durable-subagents](https://pi.dev/packages/pi-durable-subagents)
  - **pi-subagents** (v0.78.0, 2026-10-13, ~112K weekly downloads): "single-agent delegation and scripted multi-agent workflows" with preset roles (scout, researcher, evidence-auditor, worker, reviewer, oracle, delegate). — [pi.dev/packages/pi-subagents](https://pi.dev/packages/pi-subagents)
  - **pi-nostr** (coracle/jonstaab, 2026-10-02): durable bridges answer Nostr DMs (NIP-17), rooms (NIP-29) and notes. Each counterpart or room/thread maps to one durable conversation. Each reply is a durable task that signs once and republishes until a relay accepts it. Access is allowlisted by pubkey, with a warning that `from: "anyone"` hands the agent to strangers. Agent-to-agent use over Nostr relays is possible in principle but not documented. — [gitea.coracle.social/coracle/pi-nostr](https://gitea.coracle.social/coracle/pi-nostr)
  - Earlier example: the official pi-coding-agent subagent example extension spawns a separate `pi` process per subagent (single, parallel or chain modes). — [unpkg pi-coding-agent 0.73.1 subagent README](https://app.unpkg.com/@mariozechner/pi-coding-agent@0.73.1/files/examples/extensions/subagent/README.md)

### Inferences
- The authors' line runs from "no subagents in core; spawn observable processes" (2025) to "subagents as owned durable conversations" (2026). Isolation and observability stay central throughout. Communication is hierarchical (parent submits/steers, child returns a result or asks a question), plus shared versioned state. Peer messaging is absent.
- A2A/MCP bridges for inter-agent communication don't appear in author material. MCP comes up as a tool-integration feature of Pi 1.0 (via Codemode), not as an agent-to-agent channel.

### Gaps
- No author blog post found that discusses peer agents vs subagents or A2A explicitly. Armin's 2026-10-06 "What is Codemode" post was not read.
- Mario's posts index showed no Pi Durable-specific blog post. His "little piece" link on X could not be resolved.
- Talk transcripts (YouTube author talk, X video) could not be retrieved, so the authors' spoken views on Temporal/Effect.ts and multiplayer are known only from the tweet text.
