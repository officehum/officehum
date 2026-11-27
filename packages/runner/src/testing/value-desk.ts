/**
 * A test-only helper (excluded from the build): a role package around the SDK's approver-values
 * fixture role, for the eval runner's tests in this package and the office's.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { valueDeskManifest } from "../../../sdk/src/fixtures/approver-values.js";

/**
 * A role package around the SDK's approver-values fixture role (`fixtures/approver-values.ts`),
 * written to a temporary directory: its `any_credit` approval asks the person for `creditCents`,
 * 1 to 50000 cents. One ticket type, so office mode has a ticket to bind.
 */
export async function valueDeskPackage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "officehum-value-desk-"));
  const fixture = pathToFileURL(
    fileURLToPath(new URL("../../../sdk/src/fixtures/approver-values.ts", import.meta.url)),
  ).href;
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "evals"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@officehum/value-desk-eval",
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/index.ts",
      peerDependencies: {
        "@earendil-works/pi-ai": "1.6.x",
        "@earendil-works/pi-durable": "1.6.x",
      },
      dependencies: { "@officehum/sdk": "0.0.0" },
    }),
  );
  await writeFile(
    join(dir, "officehum.json"),
    JSON.stringify({
      ...valueDeskManifest,
      accepts: [
        {
          type: "credit.request",
          description: "A credit to give a client",
          done: [{ person: true }],
        },
      ],
    }),
  );
  await writeFile(
    join(dir, "AGENTS.md"),
    "# Value Desk\n\nYou give credits a person approves.\n\n## You may not\n\n- Enter an amount yourself.\n",
  );
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "A person enters every amount.\n");
  await writeFile(
    join(dir, "evals", "values.json"),
    JSON.stringify({
      stubs: { give_credit: { text: "credited" }, adjust_pay: { text: "adjusted" } },
      scenarios: [
        {
          id: "credit-at-the-approved-amount",
          description: "A credit runs with the amount the person entered",
          input: { kind: "message", text: "Credit C-1." },
          approvals: { any_credit: { decision: "approve", valueCents: 2500 } },
          expect: {
            calls: [{ tool: "give_credit", approvedValue: { name: "creditCents", cents: 2500 } }],
          },
        },
      ],
    }),
  );
  await writeFile(
    join(dir, "src", "index.ts"),
    [
      `import { valueDesk } from ${JSON.stringify(fixture)};`,
      "export default function role(options: { approve?: never }) {",
      "  return valueDesk({ approve: options.approve, gross: new Map(), writes: [] });",
      "}",
      "",
    ].join("\n"),
  );
  return dir;
}
