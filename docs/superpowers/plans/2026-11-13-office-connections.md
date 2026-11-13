# Named connections in the office file (RASF-3576)

## Goal

Front Desk and the Bookkeeper can do real work in `officehum runtime`: a role's entry in the office
file names the calendar or QuickBooks connection it uses, and the host builds the client.

## What changes

1. **Office file** (`packages/office/src/runtime/office-file.ts`): a role entry may carry
   `connections`, keyed by the client's name. Two names exist, `calendar` and `quickbooks`, each
   with its kinds and non-secret settings. Every unknown name, kind or field is reported with its
   path. `loadOfficeRoles` takes a `clientsFor` callback and passes its answer to the role.
2. **CLI** (`packages/cli/src/connections.ts`): opens what the file names. A `local` calendar is a
   SQLite file; a `google` calendar and `quickbooks` read their access token from the environment
   on every call, and a missing variable stops the runtime at start with its name.
3. **`officehum runtime`** opens the connections before it loads the roles and closes them after
   the runtime.

## Decisions

- The file keeps holding no secrets: ids and paths only. Tokens come from
  `GOOGLE_CALENDAR_ACCESS_TOKEN` (the variable solo mode already reads) and
  `QUICKBOOKS_ACCESS_TOKEN`.
- A Google calendar uses solo mode's fixed schedule (UTC, 09:00 to 12:00, one-hour slots) and a
  local file for its own record of what it did, as solo mode does.
- Parsing is in the office package and construction in the CLI: the office package does not depend
  on the QuickBooks client, and the host is where credentials are read.
- `--demo` is unchanged. It builds demonstration desks; a named connection is a different client
  and is passed beside it.

## Tests

Parsing (every refusal with its path); a missing variable named at start; Front Desk booking on a
local calendar through the runtime, with the booking still there after a restart.
