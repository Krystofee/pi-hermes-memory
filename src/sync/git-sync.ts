/**
 * One git sync run: export the live store, merge it with the remote, write the
 * result back. Algorithm and invariants: docs/GIT-SYNC.md → Sync algorithm.
 *
 * The run never force-pushes and never deletes live data it did not see in the
 * merge result; every step restarts cleanly from `lastImportedCommit`.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AtomicLockCoordinator, type AtomicLockLease } from "../store/atomic-lock-coordinator.js";
import { scanSecrets } from "../store/content-scanner.js";
import type { DatabaseManager } from "../store/db.js";
import { syncMarkdownMemoriesToSqlite } from "../handlers/sync-markdown-memories.js";
import { mergeEntryText } from "./entry-merge.js";
import {
  entryFormatFor,
  exportLiveTree,
  importTree,
  liveFileSignatures,
  readWorkTree,
  writeWorkTree,
  type LiveRoots,
  type SyncTree,
} from "./layout.js";

export const GITATTRIBUTES = [
  "* -text",
  "global/USER.md -merge",
  "global/MEMORY.md -merge",
  "global/failures.md -merge",
  "global/STANDING.md -merge",
  "projects/*/MEMORY.md -merge",
  "",
].join("\n");

const LOCK_KEY = "sync";
const LOCK_STALE_MS = 10 * 60_000;
const LOCAL_GIT_TIMEOUT_MS = 30_000;
const NETWORK_GIT_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 120_000;
const BOOTSTRAP_BRANCH = "hermes-sync-bootstrap";
const DEFAULT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=15";

export interface SyncOptions {
  repoPath: string;
  remoteUrl?: string;
  branch: string;
  roots: LiveRoots;
  agentRoot: string;
  projectsMemoryDir: string;
  /** SQLite mirror to reconcile after import; null skips it. */
  dbManager: DatabaseManager | null;
  hostname?: string;
  /** 0 = skip when another run holds the lock (background triggers). */
  waitForLockMs?: number;
  now?: () => Date;
  /** Test seams for concurrency and crash scenarios. */
  hooks?: {
    afterExport?: () => Promise<void>;
    beforeSaveState?: () => Promise<void>;
    beforePush?: () => Promise<void>;
  };
}

export interface SyncState {
  version: 1;
  liveGlobalDir: string;
  liveProjectsRoot: string;
  lastImportedCommit: string | null;
  /** relPath → sha256 of the tree at lastImportedCommit. */
  liveFingerprint: Record<string, string>;
  /** relPath → "size:mtimeMs" of live files that matched the fingerprint. */
  liveSignature: Record<string, string>;
  lastSyncAt: string | null;
  lastRemoteCheckAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  pushPending: boolean;
  /** Conflict copies present in the repository after the last run. */
  conflicts: string[];
}

export interface SyncResult {
  status: "synced" | "skipped-locked" | "error";
  committed: boolean;
  merged: boolean;
  pushed: boolean;
  offline: boolean;
  /** Conflict copies created by this run. */
  conflicts: string[];
  importedScopes: { global: boolean; projects: string[] };
  applied: string[];
  mergedConcurrent: string[];
  keptLocal: string[];
  head: string | null;
  warnings: string[];
  error: string | null;
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function emptyResult(): SyncResult {
  return {
    status: "error",
    committed: false,
    merged: false,
    pushed: false,
    offline: false,
    conflicts: [],
    importedScopes: { global: false, projects: [] },
    applied: [],
    mergedConcurrent: [],
    keptLocal: [],
    head: null,
    warnings: [],
    error: null,
  };
}

function sanitizeHost(host: string): string {
  return host.replace(/[^A-Za-z0-9._-]+/g, "-") || "host";
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

class Git {
  private sshCommand: string | null = null;

  constructor(private readonly repo: string, private readonly host: string) {}

  async init(): Promise<void> {
    if (process.env.GIT_SSH_COMMAND) return;
    const configured = await this.run(["config", "--get", "core.sshCommand"], { allowFail: true });
    if (configured.code !== 0 || !configured.stdout.toString().trim()) this.sshCommand = DEFAULT_SSH_COMMAND;
  }

  run(args: string[], options: { timeoutMs?: number; allowFail?: boolean; cwd?: string } = {}): Promise<GitResult> {
    const fullArgs = [
      "-c", "core.quotepath=false",
      "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false",
      "-c", "merge.renames=false",
      "-c", "user.name=pi-hermes-sync",
      "-c", `user.email=pi-hermes-sync@${this.host}`,
      ...args,
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" };
    if (this.sshCommand) env.GIT_SSH_COMMAND = this.sshCommand;
    return new Promise((resolve, reject) => {
      execFile("git", fullArgs, {
        cwd: options.cwd ?? this.repo,
        env,
        timeout: options.timeoutMs ?? LOCAL_GIT_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "buffer",
      }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as unknown as { code: number }).code
          : -1) : 0;
        const result = { code, stdout: stdout as Buffer, stderr: (stderr as Buffer).toString("utf-8") };
        if (code !== 0 && !options.allowFail) {
          reject(new Error(`git ${args.join(" ")} failed (${code}): ${result.stderr.trim().slice(0, 500)}`));
          return;
        }
        resolve(result);
      });
    });
  }

  async text(args: string[], options: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<string> {
    return (await this.run(args, options)).stdout.toString("utf-8").trim();
  }

  async revParse(ref: string): Promise<string | null> {
    const result = await this.run(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { allowFail: true });
    return result.code === 0 ? result.stdout.toString("utf-8").trim() : null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.run(["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true })).code === 0;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(options: SyncOptions, host: string): Promise<{ git: Git; gitDir: string }> {
  if (!(await pathExists(options.repoPath))) {
    if (!options.remoteUrl) throw new Error(`Sync repository ${options.repoPath} does not exist and no remoteUrl is configured`);
    await fs.mkdir(path.dirname(options.repoPath), { recursive: true });
    const cloner = new Git(path.dirname(options.repoPath), host);
    await cloner.init();
    await cloner.run(["clone", "--quiet", options.remoteUrl, options.repoPath], { timeoutMs: CLONE_TIMEOUT_MS });
  }
  const git = new Git(options.repoPath, host);
  const topLevel = await git.text(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!topLevel || (await fs.realpath(topLevel)) !== (await fs.realpath(options.repoPath))) {
    throw new Error(`Sync repository ${options.repoPath} is not the root of a Git work tree`);
  }
  await git.init();
  const gitDir = await git.text(["rev-parse", "--absolute-git-dir"]);
  await fs.mkdir(path.join(gitDir, "hermes-sync"), { recursive: true });
  return { git, gitDir };
}

function statePath(gitDir: string): string {
  return path.join(gitDir, "hermes-sync", "state.json");
}

async function loadState(gitDir: string): Promise<SyncState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(gitDir), "utf-8")) as SyncState;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

async function saveState(gitDir: string, state: SyncState): Promise<void> {
  const target = statePath(gitDir);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, target);
}

function freshState(roots: LiveRoots, previous: SyncState | null): SyncState {
  return {
    version: 1,
    liveGlobalDir: roots.globalDir,
    liveProjectsRoot: roots.projectsRoot,
    lastImportedCommit: null,
    liveFingerprint: {},
    liveSignature: {},
    lastSyncAt: previous?.lastSyncAt ?? null,
    lastRemoteCheckAt: previous?.lastRemoteCheckAt ?? null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastError: previous?.lastError ?? null,
    pushPending: previous?.pushPending ?? false,
    conflicts: previous?.conflicts ?? [],
  };
}

function fingerprintOf(tree: SyncTree): Record<string, string> {
  const fingerprint: Record<string, string> = {};
  for (const [relPath, file] of tree) fingerprint[relPath] = `${file.mode.toString(8)}:${sha256(file.content)}`;
  return fingerprint;
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => right[key] === left[key]);
}

export interface DirtyCheck {
  /** Live content differs from what the last run imported (or never synced). */
  dirty: boolean;
  /** Current cheap signature, for debouncing ("stable since last tick"). */
  signature: string;
}

/**
 * Cheap check used by the scheduler: compares stat signatures first and hashes
 * content only when they differ. An mtime-only change refreshes the stored
 * signature so it is not re-hashed on every tick.
 */
export async function checkLiveDirty(repoPath: string, roots: LiveRoots): Promise<DirtyCheck> {
  const current = await liveFileSignatures(roots);
  const signatureKey = sha256(Buffer.from(JSON.stringify(Object.entries(current).sort())));
  const gitDir = await gitDirOf(repoPath);
  const state = gitDir ? await loadState(gitDir) : null;
  if (!gitDir || !state || !state.lastImportedCommit
    || state.liveGlobalDir !== roots.globalDir || state.liveProjectsRoot !== roots.projectsRoot) {
    return { dirty: true, signature: signatureKey };
  }
  if (sameRecord(current, state.liveSignature)) return { dirty: false, signature: signatureKey };
  const dirty = !sameRecord(fingerprintOf(await exportLiveTree(roots)), state.liveFingerprint);
  if (!dirty) {
    // mtime-only change: refresh the cached signature, but only under the sync
    // lock — rewriting state.json next to a running sync could roll back its base.
    const lease = await acquireLock(gitDir, 0);
    if (lease) {
      try {
        const fresh = await loadState(gitDir);
        if (fresh && fresh.lastImportedCommit === state.lastImportedCommit) {
          fresh.liveSignature = current;
          await saveState(gitDir, fresh);
        }
      } finally {
        lease.release();
      }
    }
  }
  return { dirty, signature: signatureKey };
}

async function gitDirOf(repoPath: string): Promise<string | null> {
  if (!(await pathExists(repoPath))) return null;
  const result = await new Git(repoPath, os.hostname()).run(["rev-parse", "--absolute-git-dir"], { allowFail: true });
  return result.code === 0 ? result.stdout.toString("utf-8").trim() : null;
}

export async function readSyncState(repoPath: string): Promise<SyncState | null> {
  const gitDir = await gitDirOf(repoPath);
  return gitDir ? loadState(gitDir) : null;
}

async function acquireLock(gitDir: string, waitMs: number): Promise<AtomicLockLease | null> {
  const coordinator = AtomicLockCoordinator.shared(path.join(gitDir, "hermes-sync", "locks.sqlite"));
  const deadline = Date.now() + waitMs;
  let lease = coordinator.tryAcquire(LOCK_KEY, { staleMs: LOCK_STALE_MS });
  while (!lease && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    lease = coordinator.tryAcquire(LOCK_KEY, { staleMs: LOCK_STALE_MS });
  }
  return lease;
}

async function checkoutBase(git: Git, base: string | null): Promise<void> {
  await git.run(["merge", "--abort"], { allowFail: true });
  if (base) {
    await git.run(["checkout", "-q", "-f", "--detach", base]);
    await git.run(["clean", "-ffdq"]);
    return;
  }
  // Bootstrap: an empty orphan tree, so the first merge is a pure union and no
  // remote content can look like a local deletion.
  await git.run(["reset", "-q", "--hard"], { allowFail: true });
  await git.run(["clean", "-ffdq"]);
  const current = await git.text(["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true });
  if (current === BOOTSTRAP_BRANCH) await git.run(["checkout", "-q", "-f", "--detach"], { allowFail: true });
  await git.run(["branch", "-D", BOOTSTRAP_BRANCH], { allowFail: true });
  await git.run(["switch", "-q", "--orphan", BOOTSTRAP_BRANCH]);
  await git.run(["clean", "-ffdq"]);
}

function secretHits(tree: SyncTree): string[] {
  const hits: string[] = [];
  for (const [relPath, file] of tree) {
    const ids = scanSecrets(file.content.toString("utf-8"));
    if (ids.length > 0) hits.push(`${relPath} (${ids.join(", ")})`);
  }
  return hits;
}

interface UnmergedPath {
  stages: Partial<Record<1 | 2 | 3, { mode: string; sha: string }>>;
}

async function unmergedPaths(git: Git): Promise<Map<string, UnmergedPath>> {
  const raw = (await git.run(["ls-files", "-u", "-z"])).stdout.toString("utf-8");
  const paths = new Map<string, UnmergedPath>();
  for (const record of raw.split("\0").filter(Boolean)) {
    const [meta, relPath] = record.split("\t");
    const [mode, sha, stage] = meta.split(" ");
    const entry = paths.get(relPath) ?? { stages: {} };
    entry.stages[Number(stage) as 1 | 2 | 3] = { mode, sha };
    paths.set(relPath, entry);
  }
  return paths;
}

async function blob(git: Git, sha: string): Promise<Buffer> {
  return (await git.run(["cat-file", "blob", sha])).stdout;
}

async function writeRepoFile(repo: string, relPath: string, content: Buffer, gitMode: string): Promise<void> {
  const target = path.join(repo, ...relPath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const mode = gitMode === "100755" ? 0o755 : 0o644;
  await fs.rm(target, { force: true, recursive: true });
  await fs.writeFile(target, content, { mode });
  await fs.chmod(target, mode);
}

/** Resolve a stopped merge from the index stages; returns created conflict copies. */
async function resolveConflicts(git: Git, repo: string, host: string, now: Date): Promise<string[]> {
  const created: string[] = [];
  for (const [relPath, { stages }] of await unmergedPaths(git)) {
    const format = entryFormatFor(relPath);
    if (format) {
      const read = async (stage: 1 | 2 | 3) => (stages[stage] ? (await blob(git, stages[stage]!.sha)).toString("utf-8") : null);
      const merged = mergeEntryText(await read(1), await read(2), await read(3), format);
      if (!merged && !stages[2]) {
        await git.run(["rm", "-q", "--cached", "--ignore-unmatch", "--", relPath]);
        await fs.rm(path.join(repo, ...relPath.split("/")), { force: true });
        continue;
      }
      await writeRepoFile(repo, relPath, Buffer.from(merged, "utf-8"), (stages[2] ?? stages[3])!.mode);
      await git.run(["add", "--", relPath]);
      continue;
    }

    const ours = stages[2];
    const theirs = stages[3];
    if (ours) {
      await writeRepoFile(repo, relPath, await blob(git, ours.sha), ours.mode);
      await git.run(["add", "--", relPath]);
      if (theirs && relPath !== ".gitattributes" && relPath !== "README.md") {
        const copy = `conflicts/${relPath}~${host}~${utcStamp(now)}`;
        await writeRepoFile(repo, copy, await blob(git, theirs.sha), theirs.mode);
        await git.run(["add", "--", copy]);
        created.push(copy);
      }
    } else if (theirs) {
      // Deleted here, modified there: a deletion carries no content to keep.
      await writeRepoFile(repo, relPath, await blob(git, theirs.sha), theirs.mode);
      await git.run(["add", "--", relPath]);
    }
  }
  return created;
}

async function listConflictCopies(repo: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) found.push(childRel);
    }
  };
  await walk(path.join(repo, "conflicts"), "conflicts");
  return found.sort();
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const result = emptyResult();
  const host = sanitizeHost(options.hostname ?? os.hostname());
  const now = options.now ?? (() => new Date());
  let gitDir: string | null = null;
  let lease: AtomicLockLease | null = null;
  let state: SyncState | null = null;

  try {
    const repo = await ensureRepo(options, host);
    const { git } = repo;
    gitDir = repo.gitDir;
    lease = await acquireLock(gitDir, options.waitForLockMs ?? 0);
    if (!lease) {
      result.status = "skipped-locked";
      return result;
    }

    const previous = await loadState(gitDir);
    const stateValid = previous !== null
      && previous.liveGlobalDir === options.roots.globalDir
      && previous.liveProjectsRoot === options.roots.projectsRoot
      && previous.lastImportedCommit !== null
      && (await git.revParse(previous.lastImportedCommit)) !== null;
    state = stateValid ? previous : freshState(options.roots, previous);
    const base = state.lastImportedCommit;

    // 1–3: base checkout and export.
    await checkoutBase(git, base);
    const exported = await exportLiveTree(options.roots);
    await writeWorkTree(options.repoPath, exported);
    await fs.writeFile(path.join(options.repoPath, ".gitattributes"), GITATTRIBUTES);
    await options.hooks?.afterExport?.();

    // 4: never let a credential reach the remote.
    const hits = secretHits(exported);
    if (hits.length > 0) {
      throw new Error(`Blocked: secret-like content in ${hits.join("; ")}. Remove it from the live store; nothing was committed or pushed.`);
    }

    // 5: local commit with parent = base (on the orphan bootstrap branch the
    // managed .gitattributes alone makes the root commit).
    await git.run(["add", "-A"]);
    const staged = await git.run(["diff", "--cached", "--quiet"], { allowFail: true });
    if (staged.code !== 0) {
      await git.run(["commit", "-q", "-m", `sync: ${host}`]);
      result.committed = true;
    }

    // 6: fetch; any failure means offline, the run continues locally.
    const remoteUrl = await git.text(["remote", "get-url", "origin"], { allowFail: true });
    const remoteRef = `refs/remotes/origin/${options.branch}`;
    if (remoteUrl) {
      const fetched = await git.run(
        ["fetch", "-q", "--no-tags", "origin", `+refs/heads/${options.branch}:${remoteRef}`],
        { allowFail: true, timeoutMs: NETWORK_GIT_TIMEOUT_MS },
      );
      if (fetched.code === 0) {
        state.lastRemoteCheckAt = now().toISOString();
      } else if (/couldn't find remote ref/i.test(fetched.stderr)) {
        state.lastRemoteCheckAt = now().toISOString(); // online, the branch just does not exist yet
        await git.run(["update-ref", "-d", remoteRef], { allowFail: true });
      } else {
        result.offline = true;
        result.warnings.push(`fetch failed, continuing offline: ${fetched.stderr.trim().slice(0, 300)}`);
      }
    } else {
      result.offline = true;
      result.warnings.push("no origin remote configured");
    }

    // 7: merge the local branch (only differs after a crash) and the remote.
    for (const ref of [`refs/heads/${options.branch}`, remoteRef]) {
      const target = await git.revParse(ref);
      if (!target) continue;
      const head = await git.revParse("HEAD");
      if (!head) {
        await git.run(["checkout", "-q", "-f", "--detach", target]);
        continue;
      }
      if (await git.isAncestor(target, head)) continue;
      const merge = await git.run(
        ["merge", "-q", "--no-edit", "-X", "no-renames", "--allow-unrelated-histories", "-m", `sync: merge ${ref.replace("refs/", "")} on ${host}`, target],
        { allowFail: true },
      );
      result.merged = true;
      if (merge.code === 0) continue;
      const conflicted = await unmergedPaths(git);
      if (conflicted.size === 0) throw new Error(`git merge ${ref} failed: ${merge.stderr.trim().slice(0, 500)}`);
      result.conflicts.push(...await resolveConflicts(git, options.repoPath, host, now()));
      await git.run(["commit", "-q", "--no-edit"]);
    }

    // 8: move the branch to the result.
    const head = await git.revParse("HEAD");
    if (head) {
      await git.run(["checkout", "-q", "-B", options.branch]);
      await git.run(["branch", "-D", BOOTSTRAP_BRANCH], { allowFail: true });
    }
    result.head = head;

    // 9: import, then reconcile the SQLite mirror.
    const merged = await readWorkTree(options.repoPath);
    const report = await importTree(options.roots, exported, merged);
    result.applied = report.applied;
    result.mergedConcurrent = report.mergedConcurrent;
    result.keptLocal = report.keptLocal;
    result.importedScopes = report.memoryScopes;
    if (options.dbManager) {
      const counters = await syncMarkdownMemoriesToSqlite(
        options.dbManager,
        options.roots.globalDir,
        options.projectsMemoryDir,
        options.agentRoot,
        { onlyProjects: report.memoryScopes.projects },
      );
      result.warnings.push(...counters.warnings);
    }

    await options.hooks?.beforeSaveState?.();

    // 10: the live store now equals `head` except for writes made during the run.
    const fingerprint = fingerprintOf(merged);
    const signature = await liveFileSignatures(options.roots);
    const live = fingerprintOf(await exportLiveTree(options.roots));
    for (const relPath of Object.keys(signature)) {
      if (live[relPath] !== fingerprint[relPath]) signature[relPath] = "stale";
    }
    state.lastImportedCommit = head;
    state.liveFingerprint = fingerprint;
    state.liveSignature = signature;
    state.conflicts = await listConflictCopies(options.repoPath);
    await saveState(gitDir, state);

    // 11: publish. A rejected push is not an error: the next run merges again.
    const remoteHead = await git.revParse(remoteRef);
    state.pushPending = head !== null && head !== remoteHead;
    if (state.pushPending && !result.offline) {
      await options.hooks?.beforePush?.();
      const pushed = await git.run(
        ["push", "-q", "origin", `HEAD:refs/heads/${options.branch}`],
        { allowFail: true, timeoutMs: NETWORK_GIT_TIMEOUT_MS },
      );
      if (pushed.code === 0) {
        await git.run(["update-ref", remoteRef, head!]);
        state.pushPending = false;
        result.pushed = true;
      } else {
        result.warnings.push(`push failed, will retry: ${pushed.stderr.trim().slice(0, 300)}`);
      }
    }

    state.lastSyncAt = now().toISOString();
    state.lastSuccessAt = state.lastSyncAt;
    state.lastError = null;
    await saveState(gitDir, state);
    result.status = "synced";
    return result;
  } catch (error) {
    result.status = "error";
    result.error = error instanceof Error ? error.message : String(error);
    if (gitDir && lease) {
      // Record the error on the last saved state: a failed run must not move
      // lastImportedCommit or any other progress it did not finish.
      const persisted = (await loadState(gitDir)) ?? freshState(options.roots, null);
      persisted.lastSyncAt = now().toISOString();
      persisted.lastError = result.error;
      await saveState(gitDir, persisted).catch(() => {});
    }
    return result;
  } finally {
    lease?.release();
  }
}
