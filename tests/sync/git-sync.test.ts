/**
 * Two-machine integration tests for the git sync engine: real git, a bare
 * remote, real MemoryStore/SkillStore writes and a real SQLite mirror per
 * machine. No mocks.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import { DatabaseManager } from "../../src/store/db.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { searchMemories } from "../../src/store/sqlite-memory-store.js";
import type { MemoryConfig } from "../../src/types.js";
import { checkLiveDirty, readSyncState, runSync, type SyncOptions, type SyncResult } from "../../src/sync/git-sync.js";
import { rmTestDir } from "../helpers/cleanup.js";

let tmp = "";
let remote = "";
const machines: Machine[] = [];

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function remoteFiles(): string[] {
  try {
    return git(remote, "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean).sort();
  } catch {
    return [];
  }
}

function remoteFile(relPath: string): string {
  return git(remote, "show", `main:${relPath}`);
}

function remoteHead(): string | null {
  try {
    return git(remote, "rev-parse", "main");
  } catch {
    return null;
  }
}

class Machine {
  readonly root: string;
  readonly agentRoot: string;
  readonly globalDir: string;
  readonly projectsRoot: string;
  readonly repoPath: string;
  readonly db: DatabaseManager;
  readonly store: MemoryStore;
  readonly project: MemoryStore;
  readonly skills: SkillStore;

  constructor(readonly name: string) {
    this.root = path.join(tmp, name);
    this.agentRoot = path.join(this.root, "agent");
    this.globalDir = path.join(this.agentRoot, "pi-hermes-memory");
    this.projectsRoot = path.join(this.agentRoot, "projects-memory");
    this.repoPath = path.join(this.root, "repo");
    this.db = new DatabaseManager(this.globalDir);
    this.db.setQuickCheckOnOpen(false);
    this.store = new MemoryStore(storeConfig(this.globalDir));
    this.project = new MemoryStore(storeConfig(path.join(this.projectsRoot, "retino")));
    this.skills = new SkillStore({
      globalSkillsDir: path.join(this.globalDir, "skills"),
      piGlobalSkillsDir: path.join(this.root, "pi-skills"),
      projectSkillsDir: path.join(this.projectsRoot, "retino", "skills"),
      projectName: "retino",
      legacySkillsDir: path.join(this.root, "legacy-skills"),
      migrationSentinelPath: path.join(this.globalDir, ".skills-migrated-to-extension-storage"),
    });
  }

  async init(): Promise<this> {
    await this.store.loadFromDisk();
    await this.project.loadFromDisk();
    await this.skills.ensureDiscoveredRoots();
    return this;
  }

  options(extra: Partial<SyncOptions> = {}): SyncOptions {
    return {
      repoPath: this.repoPath,
      remoteUrl: remote,
      branch: "main",
      roots: { globalDir: this.globalDir, projectsRoot: this.projectsRoot },
      agentRoot: this.agentRoot,
      projectsMemoryDir: "projects-memory",
      dbManager: this.db,
      hostname: this.name,
      waitForLockMs: 5_000,
      ...extra,
    };
  }

  async sync(extra: Partial<SyncOptions> = {}): Promise<SyncResult> {
    const result = await runSync(this.options(extra));
    return result;
  }

  async syncOk(extra: Partial<SyncOptions> = {}): Promise<SyncResult> {
    const result = await this.sync(extra);
    assert.equal(result.status, "synced", `${this.name} sync failed: ${result.error}`);
    return result;
  }

  async file(...parts: string[]): Promise<string> {
    return fs.readFile(path.join(this.agentRoot, ...parts), "utf-8");
  }

  async visible(target: "memory" | "user" | "failure"): Promise<string[]> {
    const fresh = new MemoryStore(storeConfig(this.globalDir));
    await fresh.loadFromDisk();
    const entries = target === "memory" ? fresh.getMemoryEntries()
      : target === "user" ? fresh.getUserEntries() : fresh.getAllFailureEntries();
    return entries.map((entry) => entry.replace(/\s*<!--.*-->$/s, ""));
  }

  async projectVisible(): Promise<string[]> {
    const fresh = new MemoryStore(storeConfig(path.join(this.projectsRoot, "retino")));
    await fresh.loadFromDisk();
    return fresh.getMemoryEntries().map((entry) => entry.replace(/\s*<!--.*-->$/s, ""));
  }

  search(query: string, options: { target?: string; project?: string } = {}): string[] {
    return searchMemories(this.db, query, options).map((row) => row.content);
  }

  close(): void {
    this.db.close();
  }
}

async function machine(name: string): Promise<Machine> {
  const created = await new Machine(name).init();
  machines.push(created);
  return created;
}

function assertNoUnmanagedFilesInRemote(): void {
  for (const file of remoteFiles()) {
    if (file === "README.md" || file === ".gitattributes") continue;
    assert.ok(/^(global|projects|conflicts)\//.test(file), `unexpected file in remote: ${file}`);
    assert.ok(!file.split("/").slice(0, -1).some((part) => part.startsWith(".")), `dot directory in remote: ${file}`);
    assert.ok(!path.basename(file).startsWith("."), `dot file in remote: ${file}`);
    assert.ok(!/sessions\.db|recovery|\.tmp/.test(file), `local-only file in remote: ${file}`);
  }
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-git-sync-")));
  remote = path.join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", "--initial-branch=main", remote);
  // The remote starts like the real one: README + .gitattributes.
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", remote, seed);
  await fs.writeFile(path.join(seed, "README.md"), "machine managed\n");
  await fs.writeFile(path.join(seed, ".gitattributes"), "* -text\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "main");
});

afterEach(async () => {
  for (const m of machines.splice(0)) m.close();
  await rmTestDir(tmp);
});

describe("git sync between two machines", () => {
  it("bootstraps both machines as a union and never deletes existing data", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.store.add("memory", "mac global fact");
    await a.store.add("user", "mac user pref");
    await a.store.addFailure("mac lesson", { category: "tool-quirk", project: "retino" });
    await a.project.add("memory", "mac project fact");
    assert.equal((await a.skills.create("mac-only-procedure", "Procedure that only the mac knows about", "## Procedure\n1. mac step")).success, true);
    await b.store.add("memory", "dell global fact");
    await b.project.add("memory", "dell project fact");
    assert.equal((await b.skills.create("dell-only-runbook", "Runbook that only the dell knows about", "## Procedure\n1. dell step")).success, true);

    const first = await a.syncOk();
    assert.equal(first.committed, true);
    assert.equal(first.pushed, true);
    await b.syncOk();
    await a.syncOk();

    for (const m of [a, b]) {
      assert.deepEqual((await m.visible("memory")).sort(), ["dell global fact", "mac global fact"]);
      assert.deepEqual(await m.visible("user"), ["mac user pref"]);
      assert.deepEqual(await m.visible("failure"), ["[tool-quirk] mac lesson"]);
      assert.deepEqual((await m.projectVisible()).sort(), ["dell project fact", "mac project fact"]);
      assert.ok((await m.skills.loadSkill("global:mac-only-procedure")) !== null);
      assert.ok((await m.skills.loadSkill("global:dell-only-runbook")) !== null);
      assert.match(await m.file("projects-memory", "retino", "MEMORY.md"), /project fact/);
    }
    assert.equal(await fs.readFile(path.join(b.repoPath, "README.md"), "utf-8"), "machine managed\n");
    assertNoUnmanagedFilesInRemote();
  });

  it("propagates add, replace and remove for every store and keeps the SQLite mirror in step", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.syncOk();
    await b.syncOk();

    await a.store.add("user", "prefers concise czech answers");
    await a.store.add("memory", "repo lives in ~/Repos/pi-hermes-memory-repo");
    await a.store.add("memory", "obsolete server note");
    await a.store.addFailure("glab api needs explicit content type", { category: "tool-quirk", project: "retino" });
    await a.store.addFailure("same lesson text in two scopes", { category: "insight", project: "retino" });
    await a.store.addFailure("same lesson text in two scopes", { category: "insight", project: "rent-pipeline" });
    await a.project.add("memory", "retino exchange invariant");
    await a.syncOk();
    await b.syncOk();

    assert.deepEqual(await b.visible("user"), ["prefers concise czech answers"]);
    assert.equal((await b.visible("failure")).filter((e) => e === "[insight] same lesson text in two scopes").length, 2);
    assert.deepEqual(b.search("concise", { target: "user" }).length, 1);
    assert.equal(b.search("invariant", { target: "memory", project: "retino" }).length, 1);
    assert.equal(b.search("content type", { target: "failure" }).length, 1);

    assert.equal((await a.store.replace("memory", "repo lives in", "repo lives in ~/Repos/pi-hermes-memory-repo (GitLab, private)")).success, true);
    assert.equal((await a.store.remove("memory", "obsolete server note")).success, true);
    assert.equal((await a.project.remove("memory", "retino exchange invariant")).success, true);
    await a.syncOk();
    await b.syncOk();

    assert.deepEqual(await b.visible("memory"), ["repo lives in ~/Repos/pi-hermes-memory-repo (GitLab, private)"]);
    assert.deepEqual(await b.projectVisible(), []);
    assert.equal(b.search("obsolete", { target: "memory" }).length, 0);
    assert.equal(b.search("invariant", { target: "memory", project: "retino" }).length, 0);
    assert.equal(b.search("private", { target: "memory" }).length, 1);
    assertNoUnmanagedFilesInRemote();
  });

  it("keeps concurrent additions from both machines and lets a modification beat a removal", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.store.add("memory", "shared fact v1");
    await a.syncOk();
    await b.syncOk();

    await a.store.add("memory", "added on mac");
    assert.equal((await a.store.remove("memory", "shared fact v1")).success, true);
    await b.store.add("memory", "added on dell");
    assert.equal((await b.store.replace("memory", "shared fact v1", "shared fact v2 edited on dell")).success, true);
    await a.syncOk();
    await b.syncOk();
    await a.syncOk();

    const expected = ["added on dell", "added on mac", "shared fact v2 edited on dell"];
    assert.deepEqual((await a.visible("memory")).sort(), expected);
    assert.deepEqual((await b.visible("memory")).sort(), expected);
  });

  it("syncs skill create, update and delete including an executable asset", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.syncOk();
    await b.syncOk();

    assert.equal((await a.skills.create("deploy-checklist", "Checklist for deploying the fork safely", "## Procedure\n1. tag")).success, true);
    const assetDir = path.join(a.globalDir, "skills", "deploy-checklist");
    await fs.writeFile(path.join(assetDir, "check.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    assert.equal((await a.skills.create("retino-local-runbook", "Project runbook for retino worktrees", "## Procedure\n1. dev-lane", "project")).success, true);
    await a.syncOk();
    await b.syncOk();

    const asset = path.join(b.globalDir, "skills", "deploy-checklist", "check.sh");
    assert.equal((await fs.stat(asset)).mode & 0o777, 0o755);
    assert.match((await b.skills.loadSkill("global:deploy-checklist"))!.body, /1\. tag/);
    assert.ok(await b.skills.loadSkill("project:retino:retino-local-runbook"));

    assert.equal((await b.skills.patch("global:deploy-checklist", "Procedure", "1. tag\n2. push")).success, true);
    await b.syncOk();
    await a.syncOk();
    assert.match((await a.skills.loadSkill("global:deploy-checklist"))!.body, /2\. push/);

    assert.equal((await a.skills.delete("project:retino:retino-local-runbook")).success, true);
    await fs.rm(path.join(assetDir, "check.sh"));
    await a.syncOk();
    await b.syncOk();
    assert.equal(await b.skills.loadSkill("project:retino:retino-local-runbook"), null);
    await assert.rejects(fs.access(asset));
    await assert.rejects(fs.access(path.join(b.projectsRoot, "retino", "skills", "retino-local-runbook")));
  });

  it("keeps ours and preserves theirs in conflicts/ when both edit the same skill", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    assert.equal((await a.skills.create("conflicting-runbook", "Runbook edited on two machines", "## Procedure\n1. base")).success, true);
    await a.syncOk();
    await b.syncOk();

    assert.equal((await a.skills.patch("global:conflicting-runbook", "Procedure", "1. mac version")).success, true);
    assert.equal((await b.skills.patch("global:conflicting-runbook", "Procedure", "1. dell version")).success, true);
    await a.syncOk();
    const conflicted = await b.syncOk();
    await a.syncOk();

    assert.equal(conflicted.conflicts.length, 1);
    assert.match(conflicted.conflicts[0], /^conflicts\/global\/skills\/conflicting-runbook\/SKILL\.md~dell~\d{8}T\d{6}Z$/);
    for (const m of [a, b]) {
      assert.match((await m.skills.loadSkill("global:conflicting-runbook"))!.body, /dell version/);
      const state = await readSyncState(m.repoPath);
      assert.deepEqual(state?.conflicts, conflicted.conflicts);
    }
    assert.match(remoteFile(conflicted.conflicts[0]), /mac version/);
  });

  it("commits locally while offline and pushes on the next online run", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.syncOk();
    await b.syncOk();

    await fs.rename(remote, `${remote}.offline`);
    await a.store.add("memory", "written while offline");
    const offline = await a.syncOk();
    assert.equal(offline.offline, true);
    assert.equal(offline.committed, true);
    assert.equal(offline.pushed, false);
    assert.equal((await readSyncState(a.repoPath))?.pushPending, true);
    assert.deepEqual(await a.visible("memory"), ["written while offline"]);
    await fs.rename(`${remote}.offline`, remote);

    const online = await a.syncOk();
    assert.equal(online.pushed, true);
    assert.equal((await readSyncState(a.repoPath))?.pushPending, false);
    await b.syncOk();
    assert.deepEqual(await b.visible("memory"), ["written while offline"]);
  });

  it("recovers from a push rejected by a concurrent push", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.syncOk();
    await b.syncOk();

    await b.store.add("memory", "dell entry");
    await a.store.add("memory", "mac entry pushed first");
    const rejected = await b.syncOk({
      hooks: { beforePush: async () => { await a.syncOk(); } },
    });
    assert.equal(rejected.pushed, false);
    assert.equal((await readSyncState(b.repoPath))?.pushPending, true);

    const retried = await b.syncOk();
    assert.equal(retried.pushed, true);
    await a.syncOk();
    const expected = ["dell entry", "mac entry pushed first"];
    assert.deepEqual((await a.visible("memory")).sort(), expected);
    assert.deepEqual((await b.visible("memory")).sort(), expected);
  });

  it("does not lose a memory written while the run is in progress", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.syncOk();
    await b.store.add("memory", "remote entry");
    await b.syncOk();

    const during = await a.syncOk({
      hooks: { afterExport: async () => { await a.store.add("memory", "written during sync"); } },
    });
    assert.deepEqual(during.mergedConcurrent, ["global/MEMORY.md"]);
    assert.deepEqual((await a.visible("memory")).sort(), ["remote entry", "written during sync"]);
    assert.equal((await checkLiveDirty(a.repoPath, { globalDir: a.globalDir, projectsRoot: a.projectsRoot })).dirty, true);

    await a.syncOk();
    await b.syncOk();
    assert.deepEqual((await b.visible("memory")).sort(), ["remote entry", "written during sync"]);
    assert.equal((await checkLiveDirty(a.repoPath, { globalDir: a.globalDir, projectsRoot: a.projectsRoot })).dirty, false);
  });

  it("blocks secret-like content before commit and leaves the remote untouched", async () => {
    const a = await machine("mac");
    await a.syncOk();
    const before = remoteHead();
    const leakDir = path.join(a.globalDir, "skills", "leaky");
    await fs.mkdir(leakDir, { recursive: true });
    await fs.writeFile(path.join(leakDir, "SKILL.md"), "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n");
    await a.store.add("memory", "harmless fact");

    const blocked = await a.sync();
    assert.equal(blocked.status, "error");
    assert.match(blocked.error!, /global\/skills\/leaky\/SKILL\.md \(anthropic_api_key/);
    assert.equal(remoteHead(), before);
    assert.match((await readSyncState(a.repoPath))!.lastError!, /secret-like/);

    await fs.rm(leakDir, { recursive: true });
    const unblocked = await a.syncOk();
    assert.equal(unblocked.pushed, true);
    assert.equal((await readSyncState(a.repoPath))!.lastError, null);
    assert.ok(!remoteFiles().some((file) => file.includes("leaky")));
  });

  it("a run without changes neither commits nor pushes", async () => {
    const a = await machine("mac");
    await a.store.add("memory", "stable fact");
    await a.syncOk();
    const head = remoteHead();
    const again = await a.syncOk();
    assert.equal(again.committed, false);
    assert.equal(again.pushed, false);
    assert.equal(again.merged, false);
    assert.equal(remoteHead(), head);
    assert.equal((await checkLiveDirty(a.repoPath, { globalDir: a.globalDir, projectsRoot: a.projectsRoot })).dirty, false);
  });

  it("an mtime-only change is not dirty, a content change is", async () => {
    const a = await machine("mac");
    await a.store.add("memory", "fact");
    await a.syncOk();
    const roots = { globalDir: a.globalDir, projectsRoot: a.projectsRoot };
    const memoryPath = path.join(a.globalDir, "MEMORY.md");
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(memoryPath, future, future);
    assert.equal((await checkLiveDirty(a.repoPath, roots)).dirty, false);
    await a.store.add("memory", "another fact");
    assert.equal((await checkLiveDirty(a.repoPath, roots)).dirty, true);
  });

  it("ends consistent after a crash between import and saving state", async () => {
    const a = await machine("mac");
    const b = await machine("dell");
    await a.store.add("memory", "alpha from mac");
    await a.syncOk();
    await b.syncOk();
    assert.equal((await a.store.add("memory", "beta from mac")).success, true);
    assert.equal((await a.store.remove("memory", "alpha from mac")).success, true);
    await a.syncOk();
    await b.store.add("memory", "gamma from dell");

    const crashed = await b.sync({ hooks: { beforeSaveState: async () => { throw new Error("simulated crash"); } } });
    assert.equal(crashed.status, "error");
    assert.match((await readSyncState(b.repoPath))!.lastError!, /simulated crash/);
    const recovered = await b.syncOk();
    assert.equal(recovered.pushed, true);
    await a.syncOk();

    const expected = ["beta from mac", "gamma from dell"];
    assert.deepEqual((await a.visible("memory")).sort(), expected);
    assert.deepEqual((await b.visible("memory")).sort(), expected);
    assert.equal(b.search("beta", { target: "memory" }).length, 1);
    assert.equal(b.search("alpha", { target: "memory" }).length, 0);
  });

  it("skips a background run while another run holds the lock", async () => {
    const a = await machine("mac");
    await a.syncOk();
    let inner: SyncResult | null = null;
    await a.syncOk({ hooks: { afterExport: async () => { inner = await a.sync({ waitForLockMs: 0 }); } } });
    assert.equal(inner!.status, "skipped-locked");
  });

  it("publishes into a completely empty remote", async () => {
    await fs.rm(remote, { recursive: true, force: true });
    git(tmp, "init", "-q", "--bare", "--initial-branch=main", remote);
    const a = await machine("mac");
    await a.store.add("memory", "first ever entry");
    const first = await a.syncOk();
    assert.equal(first.offline, false);
    assert.equal(first.pushed, true);
    assert.deepEqual(remoteFiles(), [".gitattributes", "global/MEMORY.md"]);
    const b = await machine("dell");
    await b.syncOk();
    assert.deepEqual(await b.visible("memory"), ["first ever entry"]);
  });

  it("clones a missing repository from remoteUrl", async () => {
    const a = await machine("mac");
    await a.store.add("memory", "seeded");
    await a.syncOk();
    const b = await machine("dell");
    await fs.rm(b.repoPath, { recursive: true, force: true });
    await b.syncOk();
    assert.deepEqual(await b.visible("memory"), ["seeded"]);
    assert.equal(git(b.repoPath, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.ok(!git(b.repoPath, "branch", "--list").includes("hermes-sync-bootstrap"));
    assert.equal(await fs.readFile(path.join(a.globalDir, "MEMORY.md"), "utf-8"), (await b.file("pi-hermes-memory", "MEMORY.md")));
    assert.ok(!(await b.file("pi-hermes-memory", "MEMORY.md")).includes(`${ENTRY_DELIMITER}${ENTRY_DELIMITER}`));
  });
});
