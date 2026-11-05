/**
 * Scheduler decisions against a real repository: debounce of local changes,
 * the machine-wide remote interval, startup throttling, the shutdown deadline
 * and notification policy. Time is a fake clock; nothing waits 30 seconds.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { MemoryConfig } from "../../src/types.js";
import { readSyncState, type SyncOptions } from "../../src/sync/git-sync.js";
import { GitSyncScheduler } from "../../src/sync/scheduler.js";
import { rmTestDir } from "../helpers/cleanup.js";

let tmp = "";
let remote = "";
let clock = 0;
const dbs: DatabaseManager[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function remoteHead(): string | null {
  try {
    return git(remote, "rev-parse", "main");
  } catch {
    return null;
  }
}

function storeConfig(memoryDir: string): MemoryConfig {
  return {
    memoryMode: "policy-only", memoryCharLimit: 100_000, userCharLimit: 100_000, projectCharLimit: 100_000,
    nudgeInterval: 10, reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false, flushMinTurns: 6,
    autoConsolidate: false, correctionDetection: false, failureInjectionEnabled: false,
    failureInjectionMaxAgeDays: 7, failureInjectionMaxEntries: 5, nudgeToolCalls: 15, memoryDir,
  };
}

async function setup(name: string, extra: Partial<SyncOptions> = {}) {
  const agentRoot = path.join(tmp, name, "agent");
  const globalDir = path.join(agentRoot, "pi-hermes-memory");
  const db = new DatabaseManager(globalDir);
  db.setQuickCheckOnOpen(false);
  dbs.push(db);
  const store = new MemoryStore(storeConfig(globalDir));
  await store.loadFromDisk();
  const notifications: string[] = [];
  let options: SyncOptions = {
    repoPath: path.join(tmp, name, "repo"),
    remoteUrl: remote,
    branch: "main",
    roots: { globalDir, projectsRoot: path.join(agentRoot, "projects-memory") },
    agentRoot,
    projectsMemoryDir: "projects-memory",
    dbManager: db,
    hostname: name,
    now: () => new Date(clock),
    ...extra,
  };
  const scheduler = new GitSyncScheduler({
    syncOptions: () => options,
    remoteCheckIntervalSeconds: 300,
    notify: (message) => notifications.push(message),
    now: () => clock,
  });
  const setOptions = (patch: Partial<SyncOptions>) => { options = { ...options, ...patch }; };
  return { store, scheduler, notifications, options: () => options, setOptions, globalDir };
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sync-scheduler-")));
  remote = path.join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", "--initial-branch=main", remote);
  clock = Date.parse("2026-11-05T10:00:00Z");
});

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await rmTestDir(tmp);
});

describe("git sync scheduler", () => {
  it("pushes a local change only after it has been stable for one tick", async () => {
    const a = await setup("mac");
    assert.ok((await a.scheduler.runNow()).pushed);
    const head = remoteHead();

    await a.store.add("memory", "fresh local fact");
    assert.equal(await a.scheduler.tick(), null, "first sighting only records the signature");
    assert.equal(remoteHead(), head);
    await a.store.add("memory", "second write in the same burst");
    assert.equal(await a.scheduler.tick(), null, "a changed signature restarts the debounce");
    const pushed = await a.scheduler.tick();
    assert.equal(pushed?.status, "synced");
    assert.equal(pushed?.pushed, true);
    assert.match(git(remote, "show", "main:global/MEMORY.md"), /second write in the same burst/);
  });

  it("ignores an mtime-only change", async () => {
    const a = await setup("mac");
    await a.store.add("memory", "fact");
    await a.scheduler.runNow();
    const head = remoteHead();
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(a.globalDir, "MEMORY.md"), future, future);
    assert.equal(await a.scheduler.tick(), null);
    assert.equal(await a.scheduler.tick(), null);
    assert.equal(remoteHead(), head);
  });

  it("checks the remote once per machine-wide interval", async () => {
    const a = await setup("mac");
    const b = await setup("dell");
    await a.scheduler.runNow();
    await b.scheduler.runNow();
    await b.store.add("memory", "from dell");
    await b.scheduler.runNow();

    clock += 299_000;
    assert.equal(await a.scheduler.tick(), null, "interval not elapsed yet");
    clock += 2_000;
    const pulled = await a.scheduler.tick();
    assert.equal(pulled?.merged, true);
    assert.match(await fs.readFile(path.join(a.globalDir, "MEMORY.md"), "utf-8"), /from dell/);
    assert.equal(await a.scheduler.tick(), null, "the run reset the interval");
  });

  it("retries an unreachable remote per interval, not per tick", async () => {
    const a = await setup("mac");
    await a.scheduler.runNow();
    await fs.rename(remote, `${remote}.off`);
    clock += 301_000;
    const offline = await a.scheduler.tick();
    assert.equal(offline?.offline, true);
    clock += 30_000;
    assert.equal(await a.scheduler.tick(), null);
    await fs.rename(`${remote}.off`, remote);
  });

  it("skips the startup run right after a successful sync", async () => {
    const a = await setup("mac");
    assert.equal((await a.scheduler.startup())?.status, "synced", "never synced: run");
    clock += 10_000;
    assert.equal(await a.scheduler.startup(), null, "synced 10 s ago: skip");
    clock += 60_000;
    assert.equal((await a.scheduler.startup())?.status, "synced");
  });

  it("pushes on shutdown and never waits past the deadline", async () => {
    const a = await setup("mac");
    await a.scheduler.runNow();
    await a.store.add("memory", "written just before exit");
    await a.scheduler.shutdown(10_000);
    assert.match(git(remote, "show", "main:global/MEMORY.md"), /written just before exit/);

    await a.store.add("memory", "slow exit");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    a.setOptions({ hooks: { afterExport: () => gate } });
    const started = Date.now();
    await a.scheduler.shutdown(200);
    assert.ok(Date.now() - started < 2_000, "shutdown returned at the deadline");
    release();
    a.setOptions({ hooks: undefined });
    assert.equal((await a.scheduler.runNow()).status, "synced");
  });

  it("notifies once per failure streak and again after a recovery", async () => {
    const missing = path.join(tmp, "missing.git");
    const a = await setup("mac", { remoteUrl: missing });
    await a.scheduler.runNow();
    await a.scheduler.runNow();
    assert.equal(a.notifications.length, 1);
    assert.match(a.notifications[0], /Hermes git sync failed/);

    a.setOptions({ remoteUrl: remote });
    assert.equal((await a.scheduler.runNow()).status, "synced");
    await fs.rm(path.join(tmp, "mac", "repo", ".git"), { recursive: true, force: true });
    await a.scheduler.runNow();
    assert.equal(a.notifications.length, 2);
  });

  it("notifies about new conflict copies", async () => {
    const a = await setup("mac");
    const b = await setup("dell");
    const skill = (root: string) => path.join(root, "skills", "shared", "SKILL.md");
    await fs.mkdir(path.dirname(skill(a.globalDir)), { recursive: true });
    await fs.writeFile(skill(a.globalDir), "base\n");
    await a.scheduler.runNow();
    await b.scheduler.runNow();
    await fs.writeFile(skill(a.globalDir), "mac\n");
    await fs.writeFile(skill(b.globalDir), "dell\n");
    await a.scheduler.runNow();
    await b.scheduler.runNow();
    assert.equal(b.notifications.length, 1);
    assert.match(b.notifications[0], /conflicts\/global\/skills\/shared\/SKILL\.md~dell~/);
    assert.equal((await readSyncState(b.options().repoPath))?.conflicts.length, 1);
  });
});
