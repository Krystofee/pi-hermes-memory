import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { MemoryConfig } from "../../src/types.js";
import {
  exportLiveTree,
  importTree,
  isManagedPath,
  readWorkTree,
  writeWorkTree,
  type LiveRoots,
  type SyncTree,
} from "../../src/sync/layout.js";
import { rmTestDir } from "../helpers/cleanup.js";

let tmp = "";
let roots: LiveRoots;

function storeConfig(memoryDir: string): MemoryConfig {
  return {
    memoryMode: "policy-only",
    memoryCharLimit: 100_000,
    userCharLimit: 100_000,
    projectCharLimit: 100_000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: false,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir,
  };
}

async function write(filePath: string, content: string, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  await fs.chmod(filePath, mode);
}

function text(tree: SyncTree, relPath: string): string | undefined {
  return tree.get(relPath)?.content.toString("utf-8");
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sync-layout-"));
  roots = { globalDir: path.join(tmp, "agent", "pi-hermes-memory"), projectsRoot: path.join(tmp, "agent", "projects-memory") };
});

afterEach(async () => {
  await rmTestDir(tmp);
});

describe("sync layout", () => {
  it("exports only managed live files", async () => {
    const g = roots.globalDir;
    const p = roots.projectsRoot;
    await write(path.join(g, "MEMORY.md"), "global memory");
    await write(path.join(g, "USER.md"), "user");
    await write(path.join(g, "failures.md"), "[insight] lesson");
    await write(path.join(g, "STANDING.md"), "rule\n");
    await write(path.join(g, "sessions.db"), "sqlite");
    await write(path.join(g, "sessions.db-wal"), "wal");
    await write(path.join(g, ".MEMORY.md.recovery-1-abc"), "old");
    await write(path.join(g, ".skills-migrated-to-extension-storage"), "");
    await write(path.join(g, ".tmp-xyz", "write.tmp"), "tmp");
    await write(path.join(g, "skills", "alpha", "SKILL.md"), "alpha");
    await write(path.join(g, "skills", "alpha", ".SKILL.md.tmp-1-x"), "partial");
    await write(path.join(g, "skills", "alpha", "tool.sh"), "#!/bin/sh\n", 0o755);
    await write(path.join(g, "skills", "root-skill.md"), "root skill");
    await write(path.join(tmp, "outside.md"), "outside");
    await fs.symlink(path.join(tmp, "outside.md"), path.join(g, "skills", "alpha", "linked.md"));
    await fs.symlink(path.join(tmp), path.join(g, "skills", "linked-dir"));
    await write(path.join(p, "retino", "MEMORY.md"), "project memory");
    await write(path.join(p, "retino", ".MEMORY.md.recovery-2-def"), "old");
    await write(path.join(p, "retino", "skills", "beta", "SKILL.md"), "beta");
    await write(path.join(p, "rent-pipeline", "improvement-backlog.md"), "not synced");
    await write(path.join(p, ".pi-hermes-locks.sqlite"), "locks");
    await fs.mkdir(path.join(p, "empty", "skills"), { recursive: true });

    const tree = await exportLiveTree(roots);
    assert.deepEqual([...tree.keys()].sort(), [
      "global/MEMORY.md",
      "global/STANDING.md",
      "global/USER.md",
      "global/failures.md",
      "global/skills/alpha/SKILL.md",
      "global/skills/alpha/tool.sh",
      "global/skills/root-skill.md",
      "projects/retino/MEMORY.md",
      "projects/retino/skills/beta/SKILL.md",
    ]);
    assert.equal(tree.get("global/skills/alpha/tool.sh")?.mode, 0o755);
    assert.equal(tree.get("global/MEMORY.md")?.mode, 0o644);
  });

  it("round-trips through a work tree, preserving the executable bit", async () => {
    await write(path.join(roots.globalDir, "MEMORY.md"), `a${ENTRY_DELIMITER}b`);
    await write(path.join(roots.globalDir, "skills", "alpha", "tool.sh"), "#!/bin/sh\necho hi\n", 0o755);
    await write(path.join(roots.projectsRoot, "retino", "skills", "beta", "SKILL.md"), "beta");
    const exported = await exportLiveTree(roots);

    const workTree = path.join(tmp, "repo");
    await write(path.join(workTree, "README.md"), "keep me");
    await write(path.join(workTree, "projects", "stale", "MEMORY.md"), "removed by export");
    await writeWorkTree(workTree, exported);
    assert.equal(await fs.readFile(path.join(workTree, "README.md"), "utf-8"), "keep me");
    await assert.rejects(fs.access(path.join(workTree, "projects", "stale")));
    const fromRepo = await readWorkTree(workTree);
    assert.deepEqual([...fromRepo.keys()].sort(), [...exported.keys()].sort());

    const other: LiveRoots = { globalDir: path.join(tmp, "b", "pi-hermes-memory"), projectsRoot: path.join(tmp, "b", "projects-memory") };
    const report = await importTree(other, new Map(), fromRepo);
    assert.equal(report.applied.length, 3);
    const stat = await fs.stat(path.join(other.globalDir, "skills", "alpha", "tool.sh"));
    assert.equal(stat.mode & 0o777, 0o755);
    assert.equal(await fs.readFile(path.join(other.globalDir, "MEMORY.md"), "utf-8"), `a${ENTRY_DELIMITER}b`);
    assert.deepEqual(report.memoryScopes, { global: true, projects: [] });
  });

  it("reads only managed paths and skips symlinks from a work tree", async () => {
    const workTree = path.join(tmp, "repo");
    await write(path.join(workTree, "global", "MEMORY.md"), "m");
    await write(path.join(workTree, "global", "notes.md"), "unmanaged");
    await write(path.join(workTree, "projects", "x", "notes.md"), "unmanaged");
    await write(path.join(workTree, "conflicts", "global", "skills", "a", "SKILL.md~host~t"), "conflict");
    await fs.mkdir(path.join(workTree, "global", "skills", "evil"), { recursive: true });
    await fs.symlink("/etc/hosts", path.join(workTree, "global", "skills", "evil", "SKILL.md"));
    const tree = await readWorkTree(workTree);
    assert.deepEqual([...tree.keys()], ["global/MEMORY.md"]);
    assert.equal(isManagedPath("global/../etc/passwd"), false);
    assert.equal(isManagedPath("projects/.hidden/MEMORY.md"), false);
    assert.equal(isManagedPath("global/skills/a/.SKILL.md.tmp"), false);
    assert.equal(isManagedPath("projects/retino/skills/a/SKILL.md"), true);
  });

  it("deletes removed skill files and prunes empty skill directories only", async () => {
    await write(path.join(roots.globalDir, "skills", "gone", "nested", "SKILL.md"), "gone");
    await write(path.join(roots.globalDir, "skills", "kept", "SKILL.md"), "kept");
    await write(path.join(roots.globalDir, "skills", "kept", "asset.txt"), "asset");
    await write(path.join(roots.projectsRoot, "rent-pipeline", "improvement-backlog.md"), "untouched");
    const exported = await exportLiveTree(roots);
    const result = new Map(exported);
    result.delete("global/skills/gone/nested/SKILL.md");
    result.delete("global/skills/kept/asset.txt");

    await importTree(roots, exported, result);
    await assert.rejects(fs.access(path.join(roots.globalDir, "skills", "gone")));
    await fs.access(path.join(roots.globalDir, "skills"));
    assert.equal(await fs.readFile(path.join(roots.globalDir, "skills", "kept", "SKILL.md"), "utf-8"), "kept");
    await assert.rejects(fs.access(path.join(roots.globalDir, "skills", "kept", "asset.txt")));
    assert.equal(await fs.readFile(path.join(roots.projectsRoot, "rent-pipeline", "improvement-backlog.md"), "utf-8"), "untouched");
  });

  it("merges an entry file written during the run instead of overwriting it", async () => {
    const memoryPath = path.join(roots.projectsRoot, "retino", "MEMORY.md");
    await write(memoryPath, `a${ENTRY_DELIMITER}b`);
    const exported = await exportLiveTree(roots);
    // Remote removed b and added c.
    const result: SyncTree = new Map(exported);
    result.set("projects/retino/MEMORY.md", { content: Buffer.from(`a${ENTRY_DELIMITER}c`), mode: 0o644 });
    // A session added d after the export.
    await write(memoryPath, `a${ENTRY_DELIMITER}b${ENTRY_DELIMITER}d`);

    const report = await importTree(roots, exported, result);
    assert.deepEqual(report.mergedConcurrent, ["projects/retino/MEMORY.md"]);
    assert.deepEqual(report.memoryScopes, { global: false, projects: ["retino"] });
    assert.equal(await fs.readFile(memoryPath, "utf-8"), `a${ENTRY_DELIMITER}d${ENTRY_DELIMITER}c`);
  });

  it("keeps a skill changed during the run and reports it", async () => {
    const skillPath = path.join(roots.globalDir, "skills", "alpha", "SKILL.md");
    await write(skillPath, "v1");
    const exported = await exportLiveTree(roots);
    const result: SyncTree = new Map(exported);
    result.set("global/skills/alpha/SKILL.md", { content: Buffer.from("remote v2"), mode: 0o644 });
    await write(skillPath, "local v2");

    const report = await importTree(roots, exported, result);
    assert.deepEqual(report.keptLocal, ["global/skills/alpha/SKILL.md"]);
    assert.equal(await fs.readFile(skillPath, "utf-8"), "local v2");
  });

  it("an imported file is picked up by running and new MemoryStores without losing writes", async () => {
    const store = new MemoryStore(storeConfig(roots.globalDir));
    await store.loadFromDisk();
    assert.equal((await store.add("memory", "local before sync")).success, true);

    const exported = await exportLiveTree(roots);
    const result: SyncTree = new Map(exported);
    const merged = `${text(exported, "global/MEMORY.md")}${ENTRY_DELIMITER}remote entry <!-- created=2026-01-02, last=2026-01-02 -->`;
    result.set("global/MEMORY.md", { content: Buffer.from(merged), mode: 0o644 });
    await importTree(roots, exported, result);

    // The store loaded before the import must see the remote entry on its next write.
    assert.equal((await store.add("memory", "local after sync")).success, true);
    const reloaded = new MemoryStore(storeConfig(roots.globalDir));
    await reloaded.loadFromDisk();
    const visible = reloaded.getMemoryEntries().map((entry) => entry.replace(/\s*<!--.*-->$/s, ""));
    assert.deepEqual(visible, ["local before sync", "remote entry", "local after sync"]);
    assert.equal((await reloaded.remove("memory", "remote entry")).success, true);
  });
});
