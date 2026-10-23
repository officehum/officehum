# SDK fixtures — read this before you try to run one

**These two packages are test fixtures for `@officehum/sdk`, not runnable roles.** They exist so the
SDK's own tests have a real role package to validate, load and grade. Nothing here is published
(`"private": true`).

## Why they cannot be loaded by `officehum run`

Each fixture imports the SDK by **relative source path**:

```ts
import { defineRole } from "../../../src/index.js";   // sample-desk/src/index.ts
```

That is deliberate. It makes the SDK's tests exercise the SDK's **source**, so a change to the SDK is
covered by the fixture's tests without a build in the loop. The cost is that the path only resolves
where source and `dist` sit next to each other:

- **under vitest** it works, because Vite substitutes `.ts` for a `.js` specifier that does not exist;
- **under plain Node** — which is what the built CLI is — it fails, because there is no
  `packages/sdk/src/index.js`. The build emits `dist/`.

So `officehum run packages/sdk/fixtures/sample-stockroom` refuses, with a message that says exactly
that: the entry could not be imported, and a TypeScript source package must be built first. That
refusal is the documented, intended outcome — `fixture-packaging.test.ts` asserts it, so anyone who
changes the import form is told to revisit this file.

Declared test-only under RASF-3308. The alternative — pointing the fixtures at the `@officehum/sdk`
specifier — was rejected because the SDK's own tests would then exercise `dist` instead of source and
quietly lose coverage.

## What to use instead

For a role package you actually want to run, import the SDK by its package specifier. That is the
canonical form in `docs/design/agent-package.md` and it works everywhere:

```ts
import { defineRole } from "@officehum/sdk";
```

`agents/frontdesk/` is the working example: a real role package that the built CLI loads, runs in solo
mode and grades evals for.

## What is here

| Path | What it is |
| --- | --- |
| `sample-desk/` | A minimal portable role used across the SDK's role, package, eval and context tests. |
| `sample-stockroom/` | The engine-backed role; its `evals/` suite is the one the CLI's eval runner grades. |
| `sample-stockroom/ROLE_SPEC.md` | The four-layer spec that package is generated from (RASF-3099). It is checked in beside the fixture because the Role Factory's tests generate from it and assert the package equals the fixture on the manifest, the prompt files, the skills and the evals. |
| `overlays/` | Example overlays applied over a fixture in tests. |