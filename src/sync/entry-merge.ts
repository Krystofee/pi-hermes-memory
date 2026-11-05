/**
 * Entry-level 3-way merge for the Markdown stores shared by git sync.
 *
 * A store file is a set of entries, not text: Git's line merge would interleave
 * two machines' appends and could resurrect or duplicate entries. Merging the
 * sets keeps every write from both sides and propagates deletions, which is the
 * only contract the sync promises. See docs/GIT-SYNC.md → Merging.
 */

import { ENTRY_DELIMITER } from "../constants.js";

/** `section` = `§`-delimited MemoryStore files, `line` = STANDING.md. */
export type EntryFormat = "section" | "line";

const METADATA_PATTERN = /^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/s;

export function parseEntries(text: string, format: EntryFormat): string[] {
  if (format === "line") {
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  // Same parse as MemoryStore.readFileState, so both sides agree on entries.
  if (!text.trim()) return [];
  return text.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

export function serializeEntries(entries: string[], format: EntryFormat): string {
  if (entries.length === 0) return "";
  // Byte-compatible with StandingInstructions.write and MemoryStore.saveToDisk.
  return format === "line" ? `${entries.join("\n")}\n` : entries.join(ENTRY_DELIMITER);
}

/**
 * Entries removed on either side are dropped, additions from both sides are
 * kept. An entry edited differently on both sides survives in both versions:
 * losing a write is worse than a duplicate that consolidation can merge later.
 */
export function mergeEntries(base: string[], ours: string[], theirs: string[], format: EntryFormat): string[] {
  const baseSet = new Set(base);
  const oursSet = new Set(ours);
  const theirsSet = new Set(theirs);
  const removed = new Set(base.filter((entry) => !oursSet.has(entry) || !theirsSet.has(entry)));

  const merged = ours.filter((entry) => !removed.has(entry));
  for (const entry of theirs) {
    if (!baseSet.has(entry) && !oursSet.has(entry)) merged.push(entry);
  }
  return dedupeEntries(merged, format);
}

/** File-level wrapper; a missing file is an empty store. */
export function mergeEntryText(
  base: string | null,
  ours: string | null,
  theirs: string | null,
  format: EntryFormat,
): string {
  return serializeEntries(
    mergeEntries(
      parseEntries(base ?? "", format),
      parseEntries(ours ?? "", format),
      parseEntries(theirs ?? "", format),
      format,
    ),
    format,
  );
}

interface SectionEntry {
  text: string;
  created: string | null;
  last: string | null;
  project64: string | null;
}

function decodeSection(raw: string): SectionEntry {
  const match = raw.match(METADATA_PATTERN);
  if (!match) return { text: raw.trim(), created: null, last: null, project64: null };
  return { text: match[1].trim(), created: match[2].trim(), last: match[3].trim(), project64: match[4] ?? null };
}

function encodeSection(entry: SectionEntry): string {
  if (!entry.created || !entry.last) return entry.text;
  const project = entry.project64 ? `, project64=${entry.project64}` : "";
  return `${entry.text} <!-- created=${entry.created}, last=${entry.last}${project} -->`;
}

function minDate(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function maxDate(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

/** Same normalization StandingInstructions uses to dedupe pins. */
function lineIdentity(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Two entries with the same visible text (and failure scope) are the same
 * memory even if their timestamps differ. Keeping both would make every later
 * replace/remove on that text fail as an ambiguous match.
 */
function dedupeEntries(entries: string[], format: EntryFormat): string[] {
  if (format === "line") {
    const seen = new Set<string>();
    return entries.filter((line) => {
      const key = lineIdentity(line);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const kept: Array<{ raw: string; entry: SectionEntry; merged: boolean }> = [];
  const byIdentity = new Map<string, (typeof kept)[number]>();
  for (const raw of entries) {
    const entry = decodeSection(raw);
    const key = JSON.stringify([entry.text, entry.project64]);
    const existing = byIdentity.get(key);
    if (!existing) {
      const item = { raw, entry, merged: false };
      kept.push(item);
      byIdentity.set(key, item);
      continue;
    }
    const created = minDate(existing.entry.created, entry.created);
    const last = maxDate(existing.entry.last, entry.last);
    if (created !== existing.entry.created || last !== existing.entry.last) {
      existing.entry.created = created;
      existing.entry.last = last;
      existing.merged = true;
    }
  }
  // Untouched entries keep their exact bytes; only collapsed ones are re-encoded.
  return kept.map((item) => (item.merged ? encodeSection(item.entry) : item.raw));
}
