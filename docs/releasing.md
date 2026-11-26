# Releasing the `@officehum/*` packages

Each `@officehum/*` package has its own version (independent versioning with
[changesets](https://github.com/changesets/changesets)). Maintainers cut releases: they publish to npm
from CI, never from a laptop, every release carries npm's signed provenance (a public record tying the
tarball to the commit and the workflow run that built it), and nothing publishes until the pre-publish
check passes. No package is on npm yet.

As a contributor you add a changeset with your change; you never bump a version or publish.

## Adding a changeset (contributors)

A pull request that changes what a published package does adds a changeset: a small Markdown file in
`.changeset/` naming the packages and the bump each needs.

```sh
npx changeset
```

It asks which packages changed and whether each change is a patch (a fix), minor (something new,
nothing broken) or major (something a user has to change for). Write the summary for someone who
uses the package; it becomes the changelog entry. Commit the file with the change.

- A change to tests, docs outside a package or CI needs no changeset.
- Do not edit `version` in a `package.json` by hand, and do not run `npx changeset version` in a
  feature pull request: maintainers do both when they cut a release.
- A package that depends on another `@officehum/*` package pins its exact version (for example
  `"@officehum/sdk": "0.3.1"`). Releasing the dependency moves the pin and patches the dependent, so
  the two are always published as a tested pair.
- A change to `package-lock.json` needs `npm run licences` and the regenerated
  `THIRD_PARTY_NOTICES.md` committed with it; the licence test in `npm run check` fails otherwise.
  The notices list only third-party packages, so the version bumps in a "Version packages" pull
  request leave them unchanged.

## How a release is cut

Changesets merge to `main` with the changes they describe. When maintainers cut a release, `changeset
version` turns the pending changesets into version bumps, moves the pins in dependents and writes each
package's `CHANGELOG.md`, in a "Version packages" pull request where every version and changelog is
read before anything goes public. Once that pull request merges, CI publishes the new versions in
dependency order and tags each release (`@officehum/sdk@0.1.0`).

## The pre-publish check

`npm run publish-check` (after `npm run build`) and `scripts/publish-check.test.ts` in the normal
suite check:

- every publishable package's metadata: the licence (field and a `LICENSE` copy), a README,
  `repository`, `engines`, the `officehum` and `pi-durable` keywords, and
  `publishConfig: { "access": "public", "provenance": true }`;
- sibling dependencies pinned to the sibling's current version, never `*`;
- each `npm pack` tarball holds its entry points, README and licence, and no tests, fixtures, env
  files, npm config, Python bytecode, secret-shaped strings or source maps pointing outside the
  package;
- `validatePackage` on every role;
- the bare install: each role is packed with the `@officehum/*` packages it depends on, unpacked
  into a fresh project with only the third-party packages a role may use (Pi Durable, pi-ai,
  pi-schema, chord, typebox, semver, yaml) linked from this repository's `node_modules`, then imported
  there with Node's own resolution and validated again from the installed copy. Nothing is fetched,
  so it runs offline; it also checks the published dependency list of the role and everything it
  brings needs nothing outside that set.

`LICENSE` in each package is a copy of the root one; if the root licence changes, copy it again
(the check fails until every copy matches).

## Which packages are published

| Workspace | Why |
| --- | --- |
| `packages/sdk` | The role authoring kit every role depends on. |
| `packages/runner` | Runs one role on a Pi Durable harness; `cli` depends on it, and roles' tests use it. |
| `packages/cli` | The `officehum` command: `run`, `eval`, `verify-role`, `judge-check` and `review`. |
| `packages/memory` | Portable memory for roles. |
| `packages/provider-paper` | The portable Paper model provider for pi-ai. |
| `packages/google-calendar` | Portable client the Front Desk uses. |
| `packages/quickbooks` | Portable client the Bookkeeper depends on. |
| `packages/tools-paper-office`, `tools-documents`, `tools-docgen`, `tools-data`, `tools-esign` | Tool packs a role declares and a host supplies. |
| `packages/role-factory` | `officehum-role`, for people writing their own roles. |
| `agents/*` (15 roles) | The catalogue roles, each portable. |

Every workspace in this repository is published; there are 28 packages.
