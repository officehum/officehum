# Document tools for a role in the runtime, the Bookkeeper first (RASF-3577)

## Goal

A role whose office-file entry opts in gets the Paper Office typed document tools in
`officehum runtime`, and the files it makes land in the office's own file store.

## What changes

1. **Office file**: a role entry may carry `documents`, the formats it may produce
   (`"documents": ["xlsx"]`).
2. **CLI** (`packages/cli/src/documents.ts`): for such a role, builds the local document service
   over the office's versioned file store and the provisioned Python worker, and adds one extension
   to the role's bundle: the typed tools for those formats, and a prompt section saying what they are
   for. The runtime needs no change: it installs the bundle it is given.
3. **`officehum runtime`** opens one versioned file store (`files/` beside the board, or beside the
   database with no board). It is the same store `file` completion evidence reads, so a reply can
   attach a file the role just made.
4. **Bookkeeper**: its month-end skill says how to put the close summary in a workbook when the
   office gives it the tools.

## Decisions

- **Typed tools only.** `run_document_python` runs submitted code in a worker that is bounded but not
  yet a sandbox (the container profile is RASF-3111), so the runtime never attaches it.
- **Attached by the host, not declared by the role.** The role package stays portable and runs
  unchanged in an office with no worker. The capability and its instructions travel together in the
  host's extension.
- **A lease per task, with no inputs.** A task may create files in the formats its role was granted
  and nothing else. Editing an existing file needs the host to pin inputs, which is a later issue.
- **No interpreter is not an error.** The role loads without the tools and the runtime says so at
  start.
- **`books.close` keeps a person's confirmation alone.** A manifest cannot know whether its host has
  the worker, and `file` evidence would block every close ticket in an office without one.

## Tests

The tools are offered to the role that opted in and to no other; a lease names the task and the
granted formats; without an interpreter the role runs and the log says why; with the real worker a
workbook is created, is in the store, and satisfies `file` evidence (this one needs
`OFFICEHUM_PAPER_PYTHON` and runs in CI).
