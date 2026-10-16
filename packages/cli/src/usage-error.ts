/**
 * A usage error: bad arguments, not a runtime failure. Its own module so the run command and the main
 * CLI can both throw it without importing each other. The CLI exits 2 for one.
 */
export class UsageError extends Error {}
