# Contributing

Thank you for helping. This page is for people. Coding agents follow [`AGENTS.md`](AGENTS.md), which
is the project's working agreement and the source for the rules below; where the two differ,
`AGENTS.md` is right and this page needs fixing.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). To report a security
problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Set up

You need Node 22.19 or later (the version is in `.nvmrc`) and `python3` on the path, because the
engine-backed role tests run Python. CI uses Python 3.12.

```sh
git clone https://github.com/officehum/officehum.git
cd officehum
npm ci
npm run check
```

`npm run check` runs lint, build, typecheck and the tests. It must pass before you open a pull
request, and CI runs the same job on every pull request. Some useful commands:

```sh
npx vitest run packages/sdk/src/role.test.ts   # one test file
npm run format                                 # apply Biome formatting
npm run sync-company                           # after editing company/default/
npm run licences                               # after changing dependencies
```

The Paper Office suites need a provisioned worker interpreter in `OFFICEHUM_PAPER_PYTHON` (see
`packages/tools-paper-office/scripts/provision-worker.sh`). Without it they skip locally; CI runs
them.

The [README](README.md) explains what the agents are and how the packages fit together, and the
[quickstart](docs/quickstart.md) runs one on your machine.

## Issues

Use the templates when you open an issue: a bug, a request for a new role, or a request for a tool
pack. Work the maintainers plan is written in this format, and a pull request is easiest to review
when its issue has the same parts:

- **Goal**: what should be true when the work is done, in a sentence or two.
- **Context**: why it matters and what already exists.
- **Build**: what to make.
- **Rules**: the constraints the work must keep.
- **Tests**: what proves it works.
- **Done when**: the checks a reviewer can run.
- **Out of scope**: what this issue does not cover.

Build only what the issue asks. If something is unclear, make the smallest reasonable choice and
say so in the pull request.

## Pull requests

- One branch and one pull request per issue. Fork the repository and branch from `main`.
- Write the failing test first, then the code. Tests sit next to the code (`*.test.ts`) and make no
  network calls and no real model calls; see [Tests in `AGENTS.md`](AGENTS.md#tests).
- Keep to the house style: TypeScript strict, ES modules, Biome formatting (2 spaces, double
  quotes, semicolons, 100 columns). Comments explain why, not what.
- When behaviour changes, update the `README.md` or the relevant document under `docs/` in the same
  pull request.
- A change to what a published package does adds a changeset (`npx changeset`). When one is
  needed, and when it is not, is in [Releasing](docs/releasing.md#adding-a-changeset-contributors).
- Any change to `package-lock.json` (yours or a Dependabot update) needs `npm run licences` and the
  regenerated `THIRD_PARTY_NOTICES.md` committed with it; the test fails otherwise. Production
  dependencies must also carry a licence on the allowlist in `scripts/licences.ts`.
- Fill in the pull request template: what you built, the tests you added, the `npm run check`
  result, and anything you decided or left out.

## The hard rules

[`AGENTS.md`](AGENTS.md#hard-rules) lists the rules every change keeps. The ones most contributions
meet:

- Only `@officehum/runner`'s adapter opens and drives a Pi Durable harness.
- A role package never depends on `@officehum/runner` or `@officehum/cli` (the runner may be a
  devDependency for its tests), and its evals pass in a bare Pi Durable harness.
- Every tool states `replay: "safe"` or `"unsafe"`, in code and in `officehum.json`, and they match.
- Guardrails (approvals, budgets, limits) are code or manifest data, never only prompt text.
- Roles get no shell or file-writing tools.
- Figures come from code, engines or connected systems, never from the model's arithmetic.
- No secret goes into a file, a test, a log or a commit.

## Add a role

[Build a role](docs/build-a-role.md) covers the package, the manifest, `defineRole`, engines,
overlays, evals and the Role Factory. For a role in this repository's catalog:

1. Open a role request first, so the job, its tools and what it must ask a person about are agreed
   before code.
2. Write the role's `ROLE_SPEC.md` and generate the package with the Role Factory, or follow the
   shape of `agents/sales`. A role lives in `agents/<role>`.
3. Add it to the `build` script in the root `package.json` and to the catalog table in
   [`agents/README.md`](agents/README.md#catalog); `scripts/catalog.test.ts` checks the table
   against the manifests.
4. Run `npm run sync-company` to give it the company handbook, then `npm run check`.

## Licence

This repository is MIT licensed (see [LICENSE](LICENSE)). The licences of the packages it depends on
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
