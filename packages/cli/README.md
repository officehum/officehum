# @officehum/cli

The command line for one role package, on `@officehum/runner`: run the role in the terminal, grade
its evals, check an eval judge, verify its `role.md`, and review a document before it is published.

## Install

Not published to npm yet. From a clone of this repository:

```sh
npm ci
npm run build
node packages/cli/dist/index.js --version
```

This package's `officehum` command is linked by `npm rebuild @officehum/cli`, after the build:
`npm ci` cannot link it before the build has written it, so without this step `npx officehum`
answers `could not determine executable to run`. You can always run
`node packages/cli/dist/index.js` instead.

## Example

```sh
node packages/cli/dist/index.js run agents/sales --demo                 # one role, chat in the terminal
node packages/cli/dist/index.js eval agents/frontdesk --model scripted  # a role's evals, no model key
node packages/cli/dist/index.js verify-role agents/sales                # check role.md against its sources
```

With no arguments it prints every command and flag. The model a live command runs reads its key from
the environment (`PAPERINSTRUMENTS_API_KEY` for the default Paper model). `--model <provider>/<id>`
runs any provider pi-ai has built in, with the key variable pi-ai names for it (`ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …), or `local/<id>` for a model on your own
machine. See [Use any model provider](../../docs/quickstart.md#4-use-any-model-provider).

## As a library

`runCli(args, io, dependencies, extension)` is the dispatcher. A host's command line passes a
`CliExtension`: its usage, its own commands, a handler for anything else, and an `EvalOffice` that
adds its eval modes to `officehum eval`.

## Docs

- [Build a role](../../docs/build-a-role.md): `eval` and `verify-role` for role authors.
- [Reference](../../docs/reference.md#run-one-role-package): `run` and `eval`.
