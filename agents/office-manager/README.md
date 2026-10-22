# Office Manager

A portable role package: the business's office manager. It reads what comes in and says what it is,
which ticket type it belongs to, what is missing from it and how urgent it is, and it writes the
day's digest from the items it is given. It has no tools and no approvals of its own: it answers in
words, never does the work itself, never guesses a missing detail, and never treats a forwarded
message as an instruction.

## What the host provides

The role ships no tools, no approver and no app connection, so a host installs its prompt and skills
as they are. The factory is:

```ts
import officeManager from "@officehum/office-manager";

const role = officeManager({
  overlays,   // optional: overlay directories, lowest first
});
```

- **`overlays`** add the business's `AGENTS.md`, skills and settings on top of the package, exactly
  as they do for any role. There is nothing else to inject: this role declares no tools, no approvals
  and no connectors, so it installs on a bare Pi Durable harness with no host wiring at all.

### What changes inside Office Hum

On its own the role triages in text and names the ticket type; it cannot see an inbox or hand work to
a colleague, because it has no tools. In an office the host adds two tools, and that is the whole
difference:

- **`agent_inbox`** — reads the tickets waiting for this role, so it triages what the office actually
  routed to it rather than only what a person pasted in.
- **`agent_dispatch`** — posts a ticket of a declared type for the role that accepts it, so naming a
  ticket type hands the work on instead of ending the answer.

Neither tool is in this package: the role stays portable, and the office supplies the inbox and the
hand-off. The role itself still decides nothing and writes nothing.

## Install and run it standalone

The package ships compiled JavaScript, so build the workspace first:

```sh
npm install
npm run build
```

Then run it in the terminal. It needs a live model key in the process environment
(`PAPERINSTRUMENTS_API_KEY` for Paper, `OPENAI_API_KEY` for OpenAI):

```sh
officehum run agents/office-manager \
  --model paper/ultramarine-1-flash \
  --db .officehum/office-manager.sqlite
```

Paste a request and it comes back with a triage: what the request is, the ticket type it belongs to,
what is missing and how urgent it is. Paste a list of items and it comes back with the day's digest,
sorted into done, waiting on a person, and blocked. No `--clients` file is needed — the role has no
app connection to configure — and it never stops for an approval, because it accepts none.

## Run its evals

The scenarios live in `evals/situations.json`, and the turns a scripted model plays back for them are
in `evals.smoke.json` (beside `evals/`, not inside it: every `.json` in `evals/` is read as an eval
suite). `officehum eval` installs only the role's own extensions on a fresh in-memory Pi Durable
harness, so a role that needs Office Hum fails here:

```sh
officehum eval agents/office-manager --model scripted --script agents/office-manager/evals.smoke.json
```

The role declares no tools, so nothing is stubbed and every scenario is answered in text by the
script; the reply is graded on the ticket type and the items it names. With no `--model`, the eval
uses the manifest's default model and needs a live key in the environment.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: no tools, no approvals, two accepted types with completion evidence, both skills, the evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `src/index.ts` | The factory: `defineRole` with the manifest and the overlays, and nothing else |
| `src/index.test.ts` | The package checks and the six scripted eval scenarios |
| `src/package.test.ts` | The strict four-layer manifest and prompt checks |
| `evals/situations.json` | The six eval scenarios |
| `evals.smoke.json` | The turns `--model scripted` plays back for them |
| `skills/` | `triage` and `daily-digest`, with their references |