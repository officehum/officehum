# Office Hum

Open-source multi-agent office for medium-sized businesses, built on [Pi Durable](https://earendil.com/posts/pi-durable/).

Each specialized role inside a department, such as accounts payable in finance, a campaign manager in marketing, or a dispatcher in operations, is its own Pi Durable agent with its own instructions, tools, skills and eval suite. Agents run alone, or together on one machine where they share work through a durable workboard and a relay that delivers every hand-off exactly once.

> Status: early scaffold (milestone M0). Nothing is published yet.

## Front Desk quick start

The Front Desk runs locally, checks a synthetic calendar, requires an operator decision for every
booking, and keeps both its conversation and calendar on disk. All displayed appointment times are
UTC.

Build the workspaces, then run the credential-free demo:

```sh
npm run build
node packages/cli/dist/index.js demo --approval allow
node packages/cli/dist/index.js bookings
node packages/cli/dist/index.js resume
```

The demo always requests `2030-01-15` for `Demo Guest`, labels its inference as synthetic, and uses
the fixed request ID needed to make command retries idempotent. Omit `--approval` to use the demo's
documented automatic `allow`, or pass `--approval deny` to exercise a declined booking.

Live mode uses the installed OpenAI model catalog and reads its credential only from the process
environment:

```sh
export OPENAI_API_KEY="..."
node packages/cli/dist/index.js start \
  --message "Book Demo Guest on 2030-01-15" \
  --request-id booking-1 \
  --model gpt-6-sol
node packages/cli/dist/index.js resume
```

Without `--approval allow|deny`, live start or resume asks for the exact token `allow` or `deny`.
End-of-file or interruption leaves admitted work available to `resume`; it never implies consent.
The default state is `.officehum/frontdesk`: Pi Durable JSONL data is under `harness/`, bookings and
approval decisions are in `calendar.sqlite`, and `owner.lock` enforces one process at a time. A
second live owner is rejected. A lock whose local PID is dead is recovered; malformed locks are
left in place for inspection. Use `--state <directory>` on every command to choose another state.

## Packages

| Package | Path | What it is |
| --- | --- | --- |
| `@officehum/sdk` | `packages/sdk` | Manifest schema and helpers for building an agent package |
| `@officehum/office` | `packages/office` | Runtime: Pi Durable harness, workboard, relay, workflow engine |
| `@officehum/cli` | `packages/cli` | Run an office, watch the board, steer a live agent |
| `@officehum/<role>` | `agents/<role>` | One role agent each (Front Desk, Bookkeeper, Office Manager first) |

## Development

Requires Node 22.19 or later.

```sh
npm install
npm run check   # lint, build, typecheck, test
```

Pi Durable is pinned to an exact version (`1.0.2`). Dependabot opens a pull request for each new upstream release, and it merges only when CI passes. Each Office Hum release ships one tested Pi Durable version, so installs never upgrade Pi Durable on their own. Pi Durable's API is experimental, so all calls into it go through the adapter in `@officehum/office`.

## License

MIT. Office Hum builds on [Pi](https://github.com/earendil-works/pi), also MIT licensed (Copyright (c) 2025 Mario Zechner).
