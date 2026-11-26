# Role Factory fixtures

**These are documents, not a role package.** Nothing here is published, and nothing here runs in
place; a fixture is what `@officehum/role-factory`'s tests compare or copy into a generated package.

| Path | What it is |
| --- | --- |
| `sample-notes/ROLE_SPEC.md` | A complete four-layer spec for a neutral role, used by `src/spec.test.ts` and quoted whole in `docs/design/role-spec.md`. |
| `sample-notes/officehum.json` | The manifest the generator writes from that spec, written out. The test asserts `manifestFromRoleSpec(parseRoleSpec(spec))` equals it, and that `validateManifest` accepts it. |
| `sample-tracker/ROLE_SPEC.md` | A spec whose tools come from outside the role: two from an MCP server and one from a CLI. `src/spec.test.ts` checks its refusals; `src/generate.test.ts` generates a package from it. |
| `sample-tracker/cli/fake-tracker.mjs` | The CLI's stand-in: prints the arguments and the variable names it was given, and nothing else. The generate test copies it into the generated package and runs it with the running Node binary. |
| `sample-counts/ROLE_SPEC.md` | A spec with a `context_profile` and a reviewed `context_plan`: the prompt budget and the relevance filter accepted, amount masking declined. `src/generate.test.ts` generates a package from it. |
| `sample-counts/context.test.ts` | Not run here. The generate test copies it into the generated package and runs it there: strict checks, and a scripted 30-round session on a bare harness that stays within the 4,000-token budget with the plan and exceeds it without. |
| `sample-counts/office.test.ts` | Not run here. The generate test copies it into a package generated from the counts spec with one `engine` and one `person` type (and once with an engine check no tool can satisfy), and runs the package's `evals/office.json` in the fixture office there. |
| `sample-tracker/runtime.test.ts` | Not run here. The generate test copies it into the generated package and runs it there: strict checks, the MCP tool through `stubMcp`, the CLI tool as the script above, the approval with no approver, and the package's evals with a scripted model. |

Keep them in step: a change to one that is not made to the other fails the parse test, which is the
point — the merge is the package's `officehum.json`, or the generator has drifted.

Neutral on purpose. A fixture carries no business's domain, so the format is what a reader sees rather
than any one role's subject matter; `packages/sdk/fixtures/sample-desk` and `sample-stockroom` are the
same idea for the SDK's own tests.

The SDK's `sample-stockroom` fixture carries the same pair for a whole generated package: its
`ROLE_SPEC.md` is checked in beside it, and `src/generate.test.ts` generates the package from it and
asserts the two are equivalent on the manifest, the prompt files, the skills and the evals.