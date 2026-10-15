# FileStore final review fixes

## Changes

- `assertMetadata` now checks every `derivedFrom` index and rejects sparse holes before persistence.
- Added a shared, bounded MIME type validator for write inputs, stored references, `fileResult` references, and previews. It requires an RFC token-style `type/subtype` value no longer than 255 UTF-8 bytes.
- Added regressions for sparse metadata with no completed file installed, control and oversized MIME strings, malformed result MIME strings, and a successful `put` to `fileResult` roundtrip.

## RED/GREEN evidence

- RED: `npx vitest run packages/sdk/src/local-files.test.ts packages/sdk/src/files.test.ts` failed 5 targeted cases: sparse `derivedFrom`, control and oversized MIME writes, and malformed MIME in `fileResult`.
- GREEN: the same focused command passed: 2 test files, 56 tests.

## Checks

- `npm run check` first passed lint, build, and typecheck, then failed two existing listener tests because sandbox loopback binding returned `EPERM` on `127.0.0.1`.
- `npm run check` with loopback access passed: lint, all workspace builds, all typechecks, 33 test files, 395 tests.
- `git diff --check` passed.

## Concerns

- Biome reports an existing deprecation notice for the `recommended` configuration field in `biome.json`; it did not fail lint.
- The full test run emitted Node's existing experimental SQLite warnings.
