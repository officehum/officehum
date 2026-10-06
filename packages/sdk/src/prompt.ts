/**
 * The role layer of an agent's prompt, as Pi Durable sections. The customer layer is Pi Durable's own
 * `instructions`, which it renders after every extension section, so an upgrade to a role never
 * overwrites what the customer wrote.
 */

import { type PromptSection, section } from "@earendil-works/pi-durable";

/** Pi Durable renders the agent's `instructions` under this section key; roles may not use it. */
export const INSTRUCTIONS_SECTION_KEY = "instructions";

/** The role sections, in the order they render. */
export const ROLE_SECTION_KEYS = [
  "identity",
  "responsibilities",
  "boundaries",
  "house_style",
] as const;

type SectionText = string | PromptSection["render"];

/** What every role writes about itself. Each part is fixed text or a Pi Durable render function. */
export interface RolePrompt {
  /** Who the agent is and whom it works for. */
  readonly identity: SectionText;
  /** What it is expected to do, and to what standard. */
  readonly responsibilities: SectionText;
  /** What it must never do, and when it hands work to a person. */
  readonly boundaries: SectionText;
  /** How it writes: tone, format, sign-off. */
  readonly houseStyle: SectionText;
}

/** Builds the role's prompt sections in their fixed order: identity, responsibilities, boundaries, house style. */
export function roleSections(prompt: RolePrompt): PromptSection[] {
  const parts: readonly [string, SectionText][] = [
    ["identity", prompt.identity],
    ["responsibilities", prompt.responsibilities],
    ["boundaries", prompt.boundaries],
    ["house_style", prompt.houseStyle],
  ];
  return parts.map(([key, text]) => section(key, typeof text === "string" ? () => text : text));
}
