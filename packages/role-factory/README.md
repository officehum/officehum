# @officehum/role-factory

The Role Factory: `ROLE_SPEC.md`, one reviewable document a role is generated from, its parser, and
`officehum-role`, which interviews a person to write a spec and generates a role package from one.
The spec keeps the role's four layers (context, knowledge, workflow and wisdom) apart, and every
guardrail in it becomes manifest data, not prompt text.

## Install

Not published to npm yet. From a clone of this repository, `npm ci && npm run build`, then
`npm rebuild @officehum/role-factory` links the `officehum-role` command
(`node packages/role-factory/dist/cli.js` works without it).

## Example

```sh
npx officehum-role interview my-role.md      # asks the questions in a terminal and writes the spec
npx officehum-role generate my-role.md agents/my-role [--overlay DIR]
```

`generate` writes the manifest, `AGENTS.md`, `APPEND_SYSTEM.md`, skills, evals (including one
critical scenario per approval) and a test, as TypeScript source. Change the spec and regenerate
rather than editing the package. The fixtures under [`fixtures/`](fixtures/README.md) are complete
specs; `sample-notes/ROLE_SPEC.md` is the one [role-spec.md](../../docs/design/role-spec.md) quotes.

## Docs

- [role-spec.md](../../docs/design/role-spec.md): the format, every field, the interview and what the
  generator writes.
- [Build a role](../../docs/build-a-role.md#the-role-factory): where it fits in writing a role.
