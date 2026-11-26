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

In this repository the `officehum` command (`npx officehum`) is the office's command line, which
runs these commands and the office's; until the office leaves this repository, this package does
not link an `officehum` command of its own.

## Example

```sh
node packages/cli/dist/index.js run agents/sales --demo                 # one role, chat in the terminal
node packages/cli/dist/index.js eval agents/frontdesk --model scripted  # a role's evals, no model key
node packages/cli/dist/index.js verify-role agents/sales                # check role.md against its sources
```

With no arguments it prints every command and flag. The model a live command runs reads its key from
the environment (`PAPERINSTRUMENTS_API_KEY` for the default Paper model, `OPENAI_API_KEY` for
OpenAI).

## As a library

`runCli(args, io, dependencies, extension)` is the dispatcher. A host's command line passes a
`CliExtension`: its usage, its own commands, a handler for anything else, and an `EvalOffice` that
adds its eval modes to `officehum eval`.

## Docs

- [Build a role](../../docs/build-a-role.md): `eval` and `verify-role` for role authors.
- [Reference](../../docs/reference.md#run-one-role-package): `run` and `eval`.
