/**
 * The pre-publish check in the normal suite, so a change that would break a release fails
 * the pull request rather than the publish. It packs from the built `dist/` folders, so `npm run
 * check` runs it after the build, as it runs every other suite.
 */

import { describe, expect, it } from "vitest";
import {
  bareInstallIssues,
  metadataIssues,
  roleIssues,
  secretShapes,
  tarballIssues,
  type Workspace,
  workspaces,
} from "./publish-check.ts";

const all = workspaces();
const sdk = all.find(({ pkg }) => pkg.name === "@officehum/sdk");
if (sdk === undefined) throw new Error("the SDK workspace is missing");

describe("publish check", () => {
  it("finds every publishable package's metadata complete", () => {
    expect(metadataIssues(all)).toEqual([]);
  });

  it("finds every tarball holds its entry points, README and licence, and nothing private", () => {
    expect(tarballIssues(all)).toEqual([]);
  });

  it("finds every role valid with validatePackage", async () => {
    expect(await roleIssues(all)).toEqual([]);
  });

  it("loads every role from its tarballs in a bare project with only the allowed packages", () => {
    expect(bareInstallIssues(all)).toEqual([]);
  }, 120_000);
});

describe("publish check catches", () => {
  it("a floating sibling range, a private dependency and a missing publishConfig", () => {
    const role: Workspace = {
      dir: "agents/frontdesk",
      pkg: {
        ...(all.find(({ dir }) => dir === "agents/frontdesk")?.pkg ?? sdk.pkg),
        dependencies: { "@officehum/sdk": "*", "@officehum/private-app": "0.0.0" },
        publishConfig: { access: "public" },
      },
    };
    // A private workspace of its own, so the case holds whichever workspaces the repository has.
    const privateApp: Workspace = {
      dir: "private/private-app",
      pkg: { name: "@officehum/private-app", version: "0.0.0", private: true },
    };
    const messages = metadataIssues([
      ...all.filter(({ dir }) => dir !== role.dir),
      role,
      privateApp,
    ])
      .filter((issue) => issue.package === role.pkg.name)
      .map((issue) => issue.message);
    expect(messages).toEqual([
      'publishConfig must be { "access": "public", "provenance": true }',
      expect.stringContaining('dependencies.@officehum/sdk is "*"; pin it to "0.0.0"'),
      expect.stringContaining("@officehum/private-app is private"),
    ]);
  });

  it("a test file and a missing entry point in a tarball", () => {
    const packed = new Map([
      [
        sdk.pkg.name,
        ["package.json", "README.md", "LICENSE", "dist/index.js", "src/package.test.ts"],
      ],
    ]);
    const messages = tarballIssues([sdk], packed).map((issue) => issue.message);
    expect(messages).toContain("the tarball ships src/package.test.ts, a test");
    expect(messages).toContain("the tarball has no dist/index.d.ts, which package.json points at");
  });

  it("secret-shaped strings, but not documented placeholders", () => {
    // Built at run time so no secret-shaped literal sits in the repository.
    const fake = `sk_live_${"x".repeat(24)}`;
    expect(secretShapes(`const key = "${fake}";`)).toBe(1);
    expect(secretShapes("PAPERINSTRUMENTS_API_KEY=... node live.mjs")).toBe(0);
    expect(secretShapes(`AKIA${"IOSFODNN7"}EXAMPLE`)).toBe(0);
  });
});
