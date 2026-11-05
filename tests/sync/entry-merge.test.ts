import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import { mergeEntries, mergeEntryText, parseEntries, serializeEntries } from "../../src/sync/entry-merge.js";

const meta = (text: string, created: string, last = created, project?: string) =>
  `${text} <!-- created=${created}, last=${last}${project ? `, project64=${Buffer.from(project).toString("base64url")}` : ""} -->`;

describe("entry merge", () => {
  it("parses and serializes like MemoryStore (no trailing newline, trimmed entries)", () => {
    const text = ` a <!-- created=2026-01-01, last=2026-01-01 -->${ENTRY_DELIMITER}b\n with two lines ${ENTRY_DELIMITER}${ENTRY_DELIMITER}`;
    const entries = parseEntries(text, "section");
    assert.deepEqual(entries, ["a <!-- created=2026-01-01, last=2026-01-01 -->", "b\n with two lines"]);
    assert.equal(serializeEntries(entries, "section"), entries.join(ENTRY_DELIMITER));
    assert.deepEqual(parseEntries(serializeEntries(entries, "section"), "section"), entries);
    assert.equal(serializeEntries([], "section"), "");
    assert.deepEqual(parseEntries("  \n ", "section"), []);
  });

  it("keeps an entry added identically on both sides once", () => {
    const x = meta("same fact", "2026-02-01");
    assert.deepEqual(mergeEntries(["base"], ["base", x], ["base", x], "section"), ["base", x]);
  });

  it("keeps additions from both sides, ours first", () => {
    assert.deepEqual(mergeEntries(["a"], ["a", "ours"], ["a", "theirs"], "section"), ["a", "ours", "theirs"]);
  });

  it("propagates a removal from either side", () => {
    assert.deepEqual(mergeEntries(["a", "b"], ["a"], ["a", "b", "c"], "section"), ["a", "c"]);
    assert.deepEqual(mergeEntries(["a", "b"], ["a", "b", "c"], ["b"], "section"), ["b", "c"]);
  });

  it("remove on one side vs modify on the other keeps the modified version", () => {
    // Ours replaced b with b2; theirs removed b.
    assert.deepEqual(mergeEntries(["a", "b"], ["a", "b2"], ["a"], "section"), ["a", "b2"]);
  });

  it("keeps both versions when both sides edited the same entry", () => {
    assert.deepEqual(mergeEntries(["a", "b"], ["a", "b-ours"], ["a", "b-theirs"], "section"), ["a", "b-ours", "b-theirs"]);
  });

  it("collapses the same visible text with different timestamps: created=min, last=max", () => {
    const ours = meta("fact", "2026-03-05", "2026-03-06");
    const theirs = meta("fact", "2026-03-01", "2026-03-10");
    assert.deepEqual(mergeEntries([], [ours], [theirs], "section"), [meta("fact", "2026-03-01", "2026-03-10")]);
  });

  it("does not collapse failure copies scoped to different projects", () => {
    const a = meta("[tool-quirk] same text", "2026-01-01", "2026-01-01", "retino");
    const b = meta("[tool-quirk] same text", "2026-01-01", "2026-01-01", "rent-pipeline");
    assert.deepEqual(mergeEntries([], [a], [b], "section"), [a, b]);
  });

  it("keeps untouched entries byte-for-byte, even with unusual metadata spacing", () => {
    const odd = "fact   <!--created=2026-01-01,last=2026-01-02-->";
    assert.deepEqual(mergeEntries([odd], [odd], [odd, "new"], "section"), [odd, "new"]);
  });

  it("is a union when there is no base (bootstrap) and treats a missing file as empty", () => {
    assert.equal(mergeEntryText(null, "a", `b${ENTRY_DELIMITER}a`, "section"), `a${ENTRY_DELIMITER}b`);
    assert.equal(mergeEntryText("a", null, "a", "section"), "");
    assert.equal(mergeEntryText(null, null, "x", "section"), "x");
  });

  it("merges STANDING.md lines, dedupes case-insensitively, keeps the trailing newline", () => {
    const base = "Never force push\n";
    const ours = "Never force push\n- Answer in Czech\n";
    const theirs = "never force push\nAsk before deploys\n";
    // Theirs changed the case of an existing line: that is a removal plus an
    // addition, and the addition collapses onto nothing that survived.
    assert.equal(mergeEntryText(base, ours, theirs, "line"), "- Answer in Czech\nnever force push\nAsk before deploys\n");
    assert.equal(mergeEntryText(base, base, base, "line"), base);
    assert.equal(mergeEntryText("a\n", "", "a\n", "line"), "");
  });
});
