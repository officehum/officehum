/**
 * The board, as a host outside this package opens it.
 *
 * `openBoard` and the file name it opens are private to this directory: a colocated test refuses a
 * reference to either anywhere else under `packages/` and `agents/`, because one office's board is one
 * file with one writer. A host still has to reach a board — the CLI's `officehum board` (RASF-3134)
 * reads it, and a future Studio does too — so this module is that surface, published as
 * `@officehum/office/board`.
 *
 * It is a re-export and nothing more, and it re-exports the *real* factory rather than the test
 * helper: a host that opened through `./testing.js` would make the production path depend on a module
 * that exists to make tests convenient, and the first host bug would be a question about which of the
 * two factories it actually got.
 *
 * The name is `openOfficeBoard` rather than the board directory's own because the boundary test is a
 * *textual* rule: it refuses the string outside this directory, whoever is asking. Keeping the alias
 * makes that guard's intent explicit — a host gets a named door, not an escape hatch — instead of
 * loosening a check so one importer can spell a word.
 */
export {
  type Assignee,
  type Board,
  BoardError,
  type BoardErrorKind,
  type CompleteOptions,
  type ListFilter,
  type NewTicket,
  type Origin,
  openBoard as openOfficeBoard,
  type Person,
  type Provenance,
  type Ticket,
  type TicketEvent,
  type TicketStatus,
} from "./index.js";
