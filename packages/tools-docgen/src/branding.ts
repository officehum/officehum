/**
 * The business's branding, as data. It will come from the brand-guide skill (not built);
 * until then a host passes it in explicitly, and anything it leaves out falls back to a neutral
 * look. A model never chooses it: it is a pack option, not a tool argument, so a document cannot be
 * pointed at an arbitrary file as its "logo".
 */

import { type DataProblem, DocgenError } from "./errors.js";

export interface Branding {
  /** Printed in the letterhead (when there is no logo) and the footer. */
  readonly companyName?: string;
  /** Letterhead address lines. */
  readonly address?: readonly string[];
  /** `#RRGGBB`: headings, rules and the letterhead. */
  readonly primaryColor?: string;
  /** `#RRGGBB`: secondary text and lines. */
  readonly accentColor?: string;
  /** `#RRGGBB`: body text. */
  readonly textColor?: string;
  /** A font family; Typst falls back to Libertinus Serif when the machine does not have it. */
  readonly font?: string;
  /** A PNG or JPEG in the file store, copied into the compile directory as the letterhead logo. */
  readonly logoFileId?: string;
}

export interface ResolvedBranding {
  readonly companyName: string;
  readonly address: readonly string[];
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly textColor: string;
  readonly font: string;
  readonly logoFileId: string | null;
}

/** The neutral look used for anything branding does not say. */
export const NEUTRAL_BRANDING: ResolvedBranding = {
  companyName: "",
  address: [],
  primaryColor: "#1F2933",
  accentColor: "#52606D",
  textColor: "#1F2933",
  font: "Libertinus Serif",
  logoFileId: null,
};

const COLOR = /^#[0-9A-Fa-f]{6}$/u;
const FILE_ID = /^file_[0-9A-HJKMNP-TV-Z]{26}$/u;
const KEYS = new Set([
  "companyName",
  "address",
  "primaryColor",
  "accentColor",
  "textColor",
  "font",
  "logoFileId",
]);

/** Branding with the neutral defaults filled in, or every problem with it at once. */
export function resolveBranding(branding: Branding | undefined): ResolvedBranding {
  if (branding === undefined) return NEUTRAL_BRANDING;
  const problems: DataProblem[] = [];
  const add = (path: string, message: string) =>
    problems.push({ path: `branding.${path}`, message });
  for (const key of Object.keys(branding)) {
    if (!KEYS.has(key)) add(key, "is not a branding field");
  }
  const short = (key: "companyName" | "font", limit: number) => {
    const value = branding[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > limit || /\p{Cc}/u.test(value))
    ) {
      add(key, `must be text of at most ${limit} characters`);
    }
  };
  short("companyName", 200);
  short("font", 100);
  for (const key of ["primaryColor", "accentColor", "textColor"] as const) {
    const value = branding[key];
    if (value !== undefined && (typeof value !== "string" || !COLOR.test(value))) {
      add(key, "must be a colour written #RRGGBB, like #0B5394");
    }
  }
  const address = branding.address;
  if (
    address !== undefined &&
    (!Array.isArray(address) ||
      address.length > 8 ||
      address.some((line) => typeof line !== "string" || line.length > 200))
  ) {
    add("address", "must be at most 8 lines of at most 200 characters");
  }
  if (branding.logoFileId !== undefined && !FILE_ID.test(String(branding.logoFileId))) {
    add("logoFileId", "must be a file id from the file store, like file_01J…");
  }
  if (problems.length > 0) {
    throw new DocgenError(
      "invalid-branding",
      "the branding the host passed is not usable",
      problems,
    );
  }
  return {
    companyName: branding.companyName ?? NEUTRAL_BRANDING.companyName,
    address: [...(branding.address ?? NEUTRAL_BRANDING.address)],
    primaryColor: (branding.primaryColor ?? NEUTRAL_BRANDING.primaryColor).toUpperCase(),
    accentColor: (branding.accentColor ?? NEUTRAL_BRANDING.accentColor).toUpperCase(),
    textColor: (branding.textColor ?? NEUTRAL_BRANDING.textColor).toUpperCase(),
    font: branding.font ?? NEUTRAL_BRANDING.font,
    logoFileId: branding.logoFileId ?? null,
  };
}
