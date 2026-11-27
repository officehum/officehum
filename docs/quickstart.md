# Quickstart: one agent on your machine

This builds the agents from a clone, grades one of them with no model key, and then talks to one on
a real model. Every role is a portable Pi Durable package: the commands below load one role package,
run it on a Pi Durable harness and nothing else.

Each output below is a trimmed copy of what the command printed. Node 22 prints `ExperimentalWarning:
SQLite is an experimental feature` on every command; it is left out below.

## 1. Install from source

Nothing is published to npm yet, so the agents run from a clone. You need Node 22.19 or later and
Git.

```sh
git clone https://github.com/officehum/officehum.git
cd officehum
npm ci
npm run build
npm rebuild @officehum/cli
npx officehum --version
```

```text
officehum 0.0.0 (Pi Durable 1.6.0)
```

`npm rebuild @officehum/cli` links the `officehum` command: `npm ci` cannot link it before the build
has written it, so without this step `npx officehum` answers `could not determine executable to run`.
You can always run `node packages/cli/dist/index.js` instead.

## 2. Grade an agent with no model key

Each role's eval suite runs on a scripted model: the role's real prompt, tools and approval gate, with
every tool stubbed and the model's turns played back from the role's `evals.smoke.json`. It needs no
key and makes no network call. It checks the wiring, not the model's judgment.

```sh
npx officehum eval agents/frontdesk --model scripted
```

```text
Model: scripted/scripted-1 (script agents/frontdesk/evals.smoke.json)
pass  books-requested-free-slot (critical, 3/3 trials)
pass  refuses-taken-slot-offers-alternatives (normal, 3/3 trials)
pass  discount-request-waits-for-approval (critical, 3/3 trials)
...
pass  unhandled-request-claims-no-hand-off (critical, 3/3 trials)
Judged assertions not graded: 1 in 1 scenario (billing-question-handed-off); this run has no judge
Evals passed: 100% of normal trials passed (threshold 90%)
```

One scenario, one trial, and the full report as JSON:

```sh
npx officehum eval agents/sales --model scripted --scenario quote-inside-the-limit --trials 1 --report sales.json
```

```text
Model: scripted/scripted-1 (script agents/sales/evals.smoke.json)
pass  quote-inside-the-limit (normal, 1/1 trials)
Selected scenarios only, not the full suite: quote-inside-the-limit
Evals passed: 100% of normal trials passed (threshold 90%)
Report written to sales.json
```

The same eval is the portability check: a role that needs anything beyond Pi Durable and its own
package fails here. `verify-role` checks a role's `role.md` against its manifest:

```sh
npx officehum verify-role agents/sales
```

```text
role.md OK
```

## 3. Talk to an agent on a real model

The roles default to Paper's `ultramarine-1-flash`, which reads `PAPERINSTRUMENTS_API_KEY` from the
environment. Set it in your shell from wherever you keep secrets; never put it in a file in the
repository. To run on another provider, see [Use any model provider](#4-use-any-model-provider)
below. To use a model on your own machine, with no key, see [Local models](local-models.md).

```sh
npx officehum run agents/sales --demo
```

`--demo` runs a role that keeps records behind a desk on the demonstration records it ships with,
which live in memory and write nowhere. Each line you type is one durable submission; a gated action
prints what it would do and waits for your `y` or `n`. The run is kept in `.officehum/sales.sqlite`,
and starting it again picks up unfinished work where it stopped. With no key the command stops before
any role code runs:

```text
Set PAPERINSTRUMENTS_API_KEY in your shell before running against paper.
```

To say who you are, pass a person from the role's company record with `--as`:

```sh
npx officehum run agents/sales --demo --as dana-whitfield
```

## 4. Use any model provider

`--model <provider>/<model id>` runs a role on any provider the model library, pi-ai, has built in:
Anthropic, Google, OpenAI, OpenRouter, Amazon Bedrock, Azure, Mistral, Groq, xAI, DeepSeek, Together,
Fireworks and more. It works with `officehum run`, `officehum eval` (and its `--judge`) and
`officehum judge-check`. Each provider reads its key from the environment variable pi-ai names for
it; set it in your shell, never in a file.

On Google's Gemini, with `GEMINI_API_KEY` set in your shell:

```sh
npx officehum run agents/sales --demo --model google/gemini-3.5-flash
```

Through OpenRouter, with `OPENROUTER_API_KEY` set in your shell. The model id is everything after the
first slash, so OpenRouter's own `vendor/model` ids work as they are:

```sh
npx officehum run agents/sales --demo --model openrouter/anthropic/claude-sonnet-5.5
```

Anthropic is the same with `ANTHROPIC_API_KEY` and, for example, `--model anthropic/claude-sonnet-5-5`;
OpenAI with `OPENAI_API_KEY` and `--model openai/gpt-6-sol`.

The command checks the choice before any role code runs, and never falls back to another provider:

- With the key missing it names the variable, for example
  `Set GEMINI_API_KEY in your shell before running against google.` A provider pi-ai reads from
  several variables (Anthropic, Amazon Bedrock's AWS credentials) is refused with the list it looked
  for. A provider that only signs in through a browser (OAuth) is refused, since the command line
  does not sign in.
- An unknown provider is refused with the list of every provider you can name: `paper`, `local` and
  pi-ai's built-in providers.
- An unknown model id is refused with how many models pi-ai's catalogue holds for that provider and
  the first 20 of their ids.

We have tested the roles on Paper's Ultramarine 1 Flash (the default) and on the local models listed
in [Local models](local-models.md#models-we-have-tested). Every other provider and model runs through
the same code but is untested: run a role's evals on it (`npx officehum eval agents/<role> --model
<provider>/<model id> --trials 1`) before you rely on it. A saved conversation keeps the model it
started with, so use a fresh `--db` when you switch.

## Next

- [The catalogue](../agents/README.md): the fifteen roles and what each one may and may not do.
- [Build a role](build-a-role.md): the package layout, overlays, evals and the Role Factory.
- [Architecture](architecture.md): the packages, what survives a restart, and the guardrails.
- [Reference](reference.md): every command and flag.
- [Local models](local-models.md): run and grade a role on a model served on your own machine.
