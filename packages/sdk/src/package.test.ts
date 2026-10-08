import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatIssue } from "./issues.js";
import { supportsPiDurable, validatePackage } from "./package.js";

const sampleDir = fileURLToPath(new URL("../fixtures/sample-desk", import.meta.url));
const temps: string[] = [];

/** A copy of the sample package with one JSON file changed. */
async function sampleWith(
  file: string,
  change: (json: Record<string, unknown>) => void,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "officehum-sdk-"));
  temps.push(dir);
  await cp(sampleDir, dir, { recursive: true });
  const json = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>;
  change(json);
  await writeFile(join(dir, file), JSON.stringify(json));
  return dir;
}

const messages = async (dir: string) => {
  const result = await validatePackage(dir);
  return result.ok ? [] : result.issues.map(formatIssue);
};

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("validatePackage", () => {
  it("accepts the sample role", async () => {
    const result = await validatePackage(sampleDir);
    expect(result.issues).toEqual([]);
    if (!result.ok) return;
    expect(result.value.name).toBe("@officehum/sample-desk");
    expect(result.value.version).toBe("0.1.0");
    expect(result.value.piDurableRange).toBe("1.0.x");
    expect(Object.keys(result.value.suites)).toEqual(["evals/booking.json"]);
  });

  it("requires Pi Durable as a peer dependency, not a regular one", async () => {
    const dir = await sampleWith("package.json", (pkg) => {
      pkg.dependencies = { "@officehum/sdk": "0.0.0", "@earendil-works/pi-durable": "1.0.2" };
      delete pkg.peerDependencies;
    });
    expect(await messages(dir)).toEqual([
      "package.json › dependencies.@earendil-works/pi-durable: must be a peer dependency, so the role uses the host's copy of Pi Durable",
      'package.json › peerDependencies: must include "@earendil-works/pi-durable", e.g. "1.0.x"',
    ]);
  });

  it("refuses a dependency on the Office Hum platform", async () => {
    const dir = await sampleWith("package.json", (pkg) => {
      pkg.dependencies = { "@officehum/sdk": "0.0.0", "@officehum/office": "0.0.0" };
    });
    expect(await messages(dir)).toEqual([
      "package.json › dependencies.@officehum/office: is not allowed; a role must run on any Pi Durable install without Office Hum",
    ]);
  });

  it("checks the version and the Pi Durable range are valid", async () => {
    const dir = await sampleWith("package.json", (pkg) => {
      pkg.version = "one";
      pkg.peerDependencies = { "@earendil-works/pi-durable": "latest-ish" };
    });
    expect(await messages(dir)).toEqual([
      'package.json › version: must be a semver version (got "one")',
      'package.json › peerDependencies.@earendil-works/pi-durable: must be a semver range (got "latest-ish")',
    ]);
  });

  it("validates eval files against the manifest", async () => {
    const dir = await sampleWith("evals/booking.json", (suite) => {
      const [scenario] = suite.scenarios as Record<string, unknown>[];
      if (scenario === undefined) throw new Error("fixture has no scenarios");
      scenario.stubs = { check_schedule: { text: "Free" }, issue_refund: { text: "Done" } };
      scenario.approvals = { refund: "approve" };
      scenario.input = { kind: "ticket", type: "invoice.create", payload: {} };
    });
    expect(await messages(dir)).toEqual([
      "evals/booking.json › scenarios[0].stubs.issue_refund: is not a declared tool",
      'evals/booking.json › scenarios[0].stubs: must stub "book_appointment"; evals never call real tools',
      "evals/booking.json › scenarios[0].approvals.refund: is not a declared approval",
      'evals/booking.json › scenarios[0].input.type: "invoice.create" is not a ticket type this role accepts',
    ]);
  });

  it("checks a scenario's input against its kind", async () => {
    const dir = await sampleWith("evals/booking.json", (suite) => {
      const [scenario] = suite.scenarios as Record<string, unknown>[];
      if (scenario === undefined) throw new Error("fixture has no scenarios");
      scenario.input = { kind: "message", channel: "fax" };
    });
    expect(await messages(dir)).toEqual([
      "evals/booking.json › scenarios[0].input.text: is required",
      'evals/booking.json › scenarios[0].input.channel: must be one of "email", "sms", "chat" (got "fax")',
    ]);
  });

  it("reports missing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "officehum-sdk-"));
    temps.push(dir);
    expect(await messages(dir)).toEqual([
      "package.json: file not found",
      "officehum.json: file not found",
    ]);
  });
});

describe("supportsPiDurable", () => {
  it("matches a version against a role's range", () => {
    expect(supportsPiDurable("1.0.x", "1.0.2")).toBe(true);
    expect(supportsPiDurable("1.0.x", "1.1.0")).toBe(false);
  });
});
