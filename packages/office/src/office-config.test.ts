/**
 * The office config, and the one fact in it a webhook depends on (RASF-3162).
 *
 * The provisioner writes the number; the route reads it. Both halves are tested here over a real file
 * in a temp directory, because the failure this guards against is a config that reads back as "no
 * number" and turns every text into a 404 from a server that otherwise looks healthy.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_NUMBER, FakeNumberProvisioner, parseE164 } from "@officehum/channels";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICE_CONFIG_FILE, openOfficeConfig } from "./office-config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-config-"));
  directories.push(directory);
  return join(directory, OFFICE_CONFIG_FILE);
}

const OTHER_NUMBER = "+15005550101";

describe("office config", () => {
  it("answers no number before one is provisioned, without creating a file", () => {
    const path = configPath();
    expect(openOfficeConfig(path).smsBusinessNumber()).toBeUndefined();
    expect(() => readFileSync(path, "utf8")).toThrow(/ENOENT/);
  });

  it("writes the number a provisioner hands out, and reads it back", async () => {
    const path = configPath();
    const config = openOfficeConfig(path);
    const provisioner = new FakeNumberProvisioner(FAKE_NUMBER, config);
    const { number } = await provisioner.provision("acme-hvac");

    expect(number).toBe(FAKE_NUMBER);
    expect(config.smsBusinessNumber()).toBe(FAKE_NUMBER);
    // A second reader, in another process's position, sees the same fact from the file.
    expect(openOfficeConfig(path).smsBusinessNumber()).toBe(FAKE_NUMBER);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      sms: { businessNumber: FAKE_NUMBER },
    });
  });

  it("replaces an earlier number rather than growing a list of them", async () => {
    const path = configPath();
    const config = openOfficeConfig(path);
    await new FakeNumberProvisioner(FAKE_NUMBER, config).provision("acme-hvac");
    await new FakeNumberProvisioner(OTHER_NUMBER, config).provision("acme-hvac");

    expect(config.smsBusinessNumber()).toBe(OTHER_NUMBER);
    expect(readFileSync(path, "utf8").match(/businessNumber/g)).toHaveLength(1);
  });

  it("refuses a file a person edited into nonsense, instead of reading it as empty", () => {
    const path = configPath();
    writeFileSync(path, "{ not json", "utf8");
    expect(() => openOfficeConfig(path).smsBusinessNumber()).toThrow(/not JSON/);

    writeFileSync(path, JSON.stringify({ version: 2 }), "utf8");
    expect(() => openOfficeConfig(path).smsBusinessNumber()).toThrow(/version 2/);

    writeFileSync(
      path,
      JSON.stringify({ version: 1, sms: { businessNumber: "555-0100" } }),
      "utf8",
    );
    expect(() => openOfficeConfig(path).smsBusinessNumber()).toThrow(/E\.164/);
  });

  it("keeps the number a provisioner wrote when it writes another key", async () => {
    const path = configPath();
    const config = openOfficeConfig(path);
    await new FakeNumberProvisioner(FAKE_NUMBER, config).provision("acme-hvac");
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), extra: "kept" }),
      "utf8",
    );
    await new FakeNumberProvisioner(OTHER_NUMBER, config).provision("acme-hvac");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      extra: "kept",
      sms: { businessNumber: OTHER_NUMBER },
    });
    expect(parseE164(OTHER_NUMBER)).toBe(OTHER_NUMBER);
  });
});
