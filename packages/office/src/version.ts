/**
 * The exact Pi Durable version this release is built and tested against. It lives in its own module
 * so code inside the package (the role loader and the run session) can read it without importing the
 * package barrel and creating an import cycle. `./index.ts` re-exports it. Bumped by the upgrade
 * pipeline.
 */
export const PI_DURABLE_VERSION = "1.3.0";
