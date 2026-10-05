# Office Hum

Open-source multi-agent office for medium-sized businesses, built on [Pi Durable](https://earendil.com/posts/pi-durable/).

Each specialized role inside a department, such as accounts payable in finance, a campaign manager in marketing, or a dispatcher in operations, is its own Pi Durable agent with its own instructions, tools, skills and eval suite. Agents run alone, or together on one machine where they share work through a durable workboard and a relay that delivers every hand-off exactly once.

> Status: early scaffold (milestone M0). Nothing is published yet.

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

Pi Durable is pinned to the 1.0 line (`~1.0.2`). Its API is experimental, so upgrades go through the adapter in `@officehum/office`.

## License

MIT. Office Hum builds on [Pi](https://github.com/earendil-works/pi), also MIT licensed (Copyright (c) 2025 Mario Zechner).
