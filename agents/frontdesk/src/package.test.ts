/**
 * Front Desk as another company would install it: nothing outside the generated handbook names the
 * default company, its people, their titles or its crews.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

describe("frontdesk package", () => {
  it("names no company fact outside the generated handbook, so another company can run it", () => {
    // The shared guard: company names, people, first names, titles and crew names.
    expect(companyFactLeaks(packageDirectory)).toEqual([]);
  });
});
