#!/usr/bin/env node
/**
 * `officehum-gateway --config gateway.json`: runs an office's gateway until SIGINT or SIGTERM, then
 * stops the runtime cleanly. The JWT public key comes from OFFICEHUM_GATEWAY_JWT_PUBLIC_KEY.
 */
import { tokenKeyFromEnvironment } from "./auth.js";
import { readGatewayConfig } from "./config.js";
import { startGateway } from "./server.js";

const USAGE = "Usage: officehum-gateway --config gateway.json";

async function main(args: readonly string[]): Promise<number> {
  const at = args.indexOf("--config");
  const path = at === -1 ? undefined : args[at + 1];
  if (path === undefined || args.length !== 2) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const gateway = await startGateway({
    config: await readGatewayConfig(path),
    key: tokenKeyFromEnvironment(),
  });
  process.stderr.write(`Gateway listening on ${gateway.url}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await gateway.close();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
