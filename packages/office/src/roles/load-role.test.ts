import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PI_DURABLE_VERSION } from "../version.js";
import { loadRole } from "./load-role.js";

const sampleDesk = fileURLToPath(new URL("../../../sdk/fixtures/sample-desk", import.meta.url));
const sampleStockroom = fileURLToPath(
  new URL("../../../sdk/fixtures/sample-stockroom", import.meta.url),
);
const frontDesk = fileURLToPath(new URL("../../../../agents/frontdesk", import.meta.url));
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A copy of a fixture package with one JSON file changed, for the refusal cases. */
async function fixtureWith(
  source: string,
  file: string,
  change: (json: Record<string, unknown>) => void,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "officehum-role-"));
  temps.push(dir);
  await cp(source, dir, { recursive: true });
  const json = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>;
  change(json);
  await writeFile(join(dir, file), JSON.stringify(json));
  return dir;
}

const calendar = {
  freeSlots: async () => [] as string[],
  book: async (_start: string, _customer: string) => ({ id: "booking-1" }),
};

describe("loadRole", () => {
  it("loads the Sample Desk fixture with its named calendar client", async () => {
    const loaded = await loadRole(sampleDesk, { clients: { calendar } });
    expect(loaded.manifest.id).toBe("sample-desk");
    expect(loaded.package.name).toBe("@officehum/sample-desk");
    expect(loaded.bundle.extensions[0]?.name).toBe("sample-desk");
    const tools = loaded.bundle.extensions.flatMap((extension) =>
      (extension.tools ?? []).map((tool) => tool.name),
    );
    expect(tools).toEqual(
      expect.arrayContaining(["check_schedule", "book_appointment", "read_skill"]),
    );
    expect(loaded.reload).toBeTypeOf("function");
  });

  it("loads the Sample Stockroom fixture and builds its engine from the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "officehum-role-"));
    temps.push(dir);
    const loaded = await loadRole(sampleStockroom, {
      dataDir: join(dir, "data"),
      workDir: join(dir, "work"),
    });
    expect(loaded.manifest.id).toBe("sample-stockroom");
    expect(loaded.engine).toBeDefined();
    const tools = loaded.bundle.extensions.flatMap((extension) =>
      (extension.tools ?? []).map((tool) => tool.name),
    );
    expect(tools).toEqual(expect.arrayContaining(["stock_levels", "stock_adjust"]));
  });

  it("loads the built Front Desk role package with its calendar client", async () => {
    const loaded = await loadRole(frontDesk, { clients: { calendar } });
    expect(loaded.manifest.id).toBe("frontdesk");
    expect(loaded.package.name).toBe("@officehum/frontdesk");
    expect(loaded.bundle.extensions[0]?.name).toBe("frontdesk");
  });

  it("refuses a package whose Pi Durable peer range excludes this release", async () => {
    const dir = await fixtureWith(sampleDesk, "package.json", (pkg) => {
      pkg.peerDependencies = {
        "@earendil-works/pi-ai": "1.0.x",
        "@earendil-works/pi-durable": "1.0.x",
      };
    });
    await expect(loadRole(dir, { clients: { calendar } })).rejects.toThrow(
      new RegExp(
        `@officehum/sample-desk 0\\.1\\.0 supports Pi Durable 1\\.0\\.x, but this Office runs ${PI_DURABLE_VERSION.replaceAll(".", "\\.")}`,
      ),
    );
  });

  it("refuses a package whose required runtime is not satisfied", async () => {
    const dir = await fixtureWith(sampleStockroom, "officehum.json", (manifest) => {
      manifest.runtimes = [{ name: "python3", version: ">=99" }];
    });
    await expect(
      loadRole(dir, { dataDir: join(dir, "data"), workDir: join(dir, "work") }),
    ).rejects.toThrow(/sample-stockroom needs programs this machine is missing[\s\S]*python3/);
  });

  it("names every validation problem at once", async () => {
    const dir = await fixtureWith(sampleDesk, "package.json", (pkg) => {
      pkg.dependencies = { "@officehum/sdk": "0.0.0", "@officehum/office": "0.0.0" };
    });
    await expect(loadRole(dir)).rejects.toThrow(/@officehum\/office.*not allowed/);
  });

  it("explains an entry point it cannot import", async () => {
    // A copy outside the repo: the fixture's relative SDK import no longer resolves, which is the
    // shape of a TypeScript source package the run command cannot load.
    const dir = await mkdtemp(join(tmpdir(), "officehum-role-"));
    temps.push(dir);
    await cp(sampleDesk, dir, { recursive: true });
    await expect(loadRole(dir, { clients: { calendar } })).rejects.toThrow(
      /Could not import @officehum\/sample-desk's entry point[\s\S]*compiled JavaScript/,
    );
  });

  it("refuses a client named after a factory option loadRole sets itself", async () => {
    await expect(loadRole(sampleDesk, { clients: { calendar, overlays: [] } })).rejects.toThrow(
      /The client named "overlays" is reserved/,
    );
  });
});
