# Role Factory fixtures

**These are documents, not a role package.** Nothing here is published and nothing here runs; a
fixture is the pair `@officehum/role-factory`'s tests compare.

| Path | What it is |
| --- | --- |
| `sample-notes/ROLE_SPEC.md` | A complete four-layer spec for a neutral role, used by `src/spec.test.ts` and quoted whole in `docs/design/role-spec.md`. |
| `sample-notes/officehum.json` | The manifest the generator writes from that spec, written out. The test asserts `manifestFromRoleSpec(parseRoleSpec(spec))` equals it, and that `validateManifest` accepts it. |

Keep them in step: a change to one that is not made to the other fails the parse test, which is the
point — the merge is the package's `officehum.json`, or the generator has drifted.

Neutral on purpose. A fixture carries no business's domain, so the format is what a reader sees rather
than any one role's subject matter; `packages/sdk/fixtures/sample-desk` and `sample-stockroom` are the
same idea for the SDK's own tests.

The SDK's `sample-stockroom` fixture carries the same pair for a whole generated package: its
`ROLE_SPEC.md` is checked in beside it, and `src/generate.test.ts` generates the package from it and
asserts the two are equivalent on the manifest, the prompt files, the skills and the evals.