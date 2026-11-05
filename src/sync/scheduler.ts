/**
 * When to run git sync inside a Pi session (docs/GIT-SYNC.md → Scheduling).
 *
 * Several Pi sessions on one machine all run a scheduler. They coordinate only
 * through the repository: the sync lock and the timestamps in state.json, so
 * the machine checks the remote at most once per interval regardless of how
 * many sessions are open.
 */

import { checkLiveDirty, readSyncState, runSync, type SyncOptions, type SyncResult } from "./git-sync.js";

export const SYNC_TICK_MS = 30_000;
export const STARTUP_SKIP_AFTER_SYNC_MS = 60_000;
export const SHUTDOWN_DEADLINE_MS = 10_000;
export const MANUAL_LOCK_WAIT_MS = 30_000;

export type SyncNotify = (message: string, level: "info" | "warning" | "error") => void;

export interface SchedulerOptions {
  /** Built per run so callers can supply a database that opens lazily. */
  syncOptions: () => SyncOptions;
  remoteCheckIntervalSeconds: number;
  notify: SyncNotify;
  now?: () => number;
}

export class GitSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<SyncResult> | null = null;
  private pendingSignature: string | null = null;
  private lastStatus: SyncResult["status"] | null = null;

  constructor(private readonly options: SchedulerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, SYNC_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One run at a time per process; background runs skip a held lock. */
  private run(waitForLockMs: number): Promise<SyncResult> {
    if (this.running) return this.running;
    const options = { ...this.options.syncOptions(), waitForLockMs };
    this.running = runSync(options)
      .then((result) => {
        this.report(result);
        return result;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Quiet unless something needs the user: a new failure or a new conflict. */
  private report(result: SyncResult): void {
    if (result.status === "error") {
      if (this.lastStatus !== "error") this.options.notify(`⚠️ Hermes git sync failed: ${result.error}`, "warning");
      this.lastStatus = "error";
      return;
    }
    if (result.status === "synced") this.lastStatus = "synced";
    if (result.conflicts.length > 0) {
      this.options.notify(
        `⚠️ Hermes git sync kept the local version and saved the other side to ${result.conflicts.join(", ")} — merge it by hand and delete the copy.`,
        "warning",
      );
    }
  }

  /** Any attempt counts, so an unreachable remote is retried once per interval, not per tick. */
  private async remoteCheckDue(): Promise<boolean> {
    const state = await readSyncState(this.options.syncOptions().repoPath);
    const last = Math.max(
      state?.lastRemoteCheckAt ? Date.parse(state.lastRemoteCheckAt) : 0,
      state?.lastSyncAt ? Date.parse(state.lastSyncAt) : 0,
    );
    return this.now() - last >= this.options.remoteCheckIntervalSeconds * 1000;
  }

  /**
   * Local changes are pushed once they have been stable for one tick, so a
   * burst of writes becomes one commit. Otherwise the remote is checked when
   * the machine-wide interval elapsed.
   */
  async tick(): Promise<SyncResult | null> {
    if (this.running) return null;
    try {
      const options = this.options.syncOptions();
      const state = await readSyncState(options.repoPath);
      const lastAttempt = state?.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
      // A failing run (secret gate, broken repo) retries once per interval,
      // not on every tick; /memory-git-sync still runs immediately.
      if (state?.lastError && this.now() - lastAttempt < this.options.remoteCheckIntervalSeconds * 1000) return null;
      const check = await checkLiveDirty(options.repoPath, options.roots);
      if (check.dirty) {
        if (this.pendingSignature !== check.signature) {
          this.pendingSignature = check.signature;
          return null;
        }
        this.pendingSignature = null;
        return await this.run(0);
      }
      this.pendingSignature = null;
      if (await this.remoteCheckDue()) return await this.run(0);
      return null;
    } catch (error) {
      this.options.notify(`⚠️ Hermes git sync check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return null;
    }
  }

  /** Pull at session start, unless another session just did. */
  async startup(): Promise<SyncResult | null> {
    const state = await readSyncState(this.options.syncOptions().repoPath);
    const last = state?.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
    if (state?.lastError === null && this.now() - last < STARTUP_SKIP_AFTER_SYNC_MS) return null;
    return this.run(0);
  }

  /** Push what this session wrote before it exits; bounded and never throws. */
  async shutdown(deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<void> {
    this.stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, deadlineMs);
      timeout.unref?.();
    });
    const work = (async () => {
      if (this.running) await this.running;
      const options = this.options.syncOptions();
      if ((await checkLiveDirty(options.repoPath, options.roots)).dirty) await this.run(0);
    })().catch(() => {});
    try {
      await Promise.race([work, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** /memory-git-sync: run now, waiting for a concurrent run to finish. */
  async runNow(): Promise<SyncResult> {
    if (this.running) await this.running.catch(() => {});
    return this.run(MANUAL_LOCK_WAIT_MS);
  }
}
