/**
 * Machine signatures for memories shared through git sync (docs/GIT-SYNC.md →
 * Signatures). A fact true on one machine (a path, a runtime, a port) can be
 * false on another; once synced, a plain replace on the second machine would
 * silently take the first machine's fact away. Entries therefore carry the
 * machine that wrote them, and only that machine may replace or remove them.
 *
 * The signature is part of the visible text, `[@name] fact` (after the
 * `[category]` tag for lessons), so every reader sees it: memory_search,
 * injected lessons, consolidation and the SQLite mirror need no extra field.
 */

import * as os from "node:os";

const CATEGORY_TAG = /^\[(?:failure|correction|insight|preference|convention|tool-quirk)\]\s+/;
const SIGNATURE = /^\[@([A-Za-z0-9._-]+)\]\s*/;
const MACHINE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidMachineName(name: string): boolean {
  return MACHINE_NAME.test(name);
}

/** Short hostname (without the .local style domain), usable as a signature. */
export function defaultMachineName(hostname = os.hostname()): string {
  const short = hostname.split(".")[0].replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return short.slice(0, 64) || "machine";
}

function splitCategory(text: string): { category: string; rest: string } {
  const match = text.match(CATEGORY_TAG);
  return match ? { category: match[0], rest: text.slice(match[0].length) } : { category: "", rest: text };
}

/** Machine that signed this entry text (metadata already stripped), or null. */
export function entryOwner(text: string): string | null {
  return splitCategory(text.trim()).rest.match(SIGNATURE)?.[1] ?? null;
}

/** Text with exactly one signature: `owner`'s, replacing any the writer typed. */
export function signEntry(text: string, owner: string): string {
  const { category, rest } = splitCategory(text.trim());
  return `${category}[@${owner}] ${rest.replace(SIGNATURE, "")}`;
}

export function foreignOwnerError(owner: string, machine: string, kind: "entry" | "skill"): string {
  return `Refusing: this ${kind} belongs to machine '${owner}' and this machine is '${machine}'. `
    + "Memories and skills are shared between machines and facts can differ per machine, so do not "
    + `overwrite or delete another machine's ${kind}. `
    + (kind === "entry"
      ? "If it is different here, add your own entry with memory_add (it is signed for this machine automatically). "
      : `Add what differs here as your own section with skill_manage action=patch section="Notes (${machine})". `)
    + "Only if the user explicitly asked to change the other machine's version, retry with override_owner=true.";
}

/** Always-injected rule; the refusal above enforces it, this keeps agents from trying. */
export function machinePolicyPrompt(machine: string): string {
  return [
    "<memory-machine>",
    `This machine is '${machine}'. Memories and skills are shared with the user's other machines through git sync.`,
    "Memory entries are signed [@machine] automatically and skills carry an author.",
    "Facts can differ per machine (paths, runtimes, ports, installed tools, services). When another machine's entry or skill",
    `does not match what you see here, keep it: add your own entry for this machine, or patch a "Notes (${machine})" section`,
    "of the skill. Change another machine's entry or skill only when the user explicitly asks, using override_owner=true.",
    "</memory-machine>",
  ].join("\n");
}
