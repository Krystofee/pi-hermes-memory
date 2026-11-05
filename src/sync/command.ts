/**
 * /memory-git-sync — run the git sync now, or show its status.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readSyncStatus, type SyncOptions, type SyncResult, type SyncStatus } from "./git-sync.js";
import type { GitSyncScheduler } from "./scheduler.js";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatSyncResult(result: SyncResult): string {
  if (result.status === "skipped-locked") return "⏳ Another session is syncing right now — try again in a moment.";
  if (result.status === "error") return `❌ Hermes git sync failed: ${result.error}`;

  const done: string[] = [];
  if (result.committed) done.push("committed local changes");
  if (result.merged) done.push("merged remote changes");
  if (result.pushed) done.push("pushed");
  let output = `✅ Hermes git sync ${done.length > 0 ? done.join(", ") : "found nothing to change"}.`;
  const imported = result.applied.length + result.mergedConcurrent.length;
  if (imported > 0) output += `\n├─ Updated ${plural(imported, "local file")}`;
  if (result.offline) output += "\n├─ Offline: changes stay local until the remote is reachable";
  if (result.keptLocal.length > 0) output += `\n├─ Changed during the run, synced next time: ${result.keptLocal.join(", ")}`;
  if (result.conflicts.length > 0) output += `\n├─ ⚠️ Conflict copies: ${result.conflicts.join(", ")}`;
  for (const warning of result.warnings.slice(0, 3)) output += `\n├─ ${warning}`;
  return output;
}

export function formatSyncStatus(status: SyncStatus): string {
  const state = status.state;
  const lines = [
    "🔄 Hermes git sync",
    `├─ Repo: ${status.repoPath}${status.repoExists ? "" : " (not cloned yet)"}`,
    `├─ Remote: ${status.remoteUrl ?? "none"} (${status.branch})`,
    `├─ Last success: ${state?.lastSuccessAt ?? "never"}`,
    `├─ Last remote check: ${state?.lastRemoteCheckAt ?? "never"}`,
    `├─ Last error: ${state?.lastError ?? "none"}`,
    `├─ Local changes waiting: ${status.dirty ? "yes" : "no"}`,
    `├─ Push pending: ${state?.pushPending ? "yes" : "no"}`,
  ];
  const conflicts = state?.conflicts ?? [];
  if (conflicts.length === 0) {
    lines.push("└─ Conflicts: none");
  } else {
    lines.push(`└─ Conflicts: ${conflicts.length} in ${status.repoPath}`);
    for (const copy of conflicts.slice(0, 5)) lines.push(`   • ${copy}`);
    if (conflicts.length > 5) lines.push(`   … and ${conflicts.length - 5} more`);
  }
  return lines.join("\n");
}

export function registerGitSyncCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  scheduler: GitSyncScheduler,
  syncOptions: () => SyncOptions,
): void {
  pi.registerCommand("memory-git-sync", {
    description: "Sync memories and skills with the git repository now (or: status)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = (args ?? "").trim();
      if (action === "status") {
        ctx.ui.notify(formatSyncStatus(await readSyncStatus(syncOptions())), "info");
        return;
      }
      if (action !== "") {
        ctx.ui.notify("Usage: /memory-git-sync [status]", "warning");
        return;
      }
      ctx.ui.notify("🔄 Syncing memories and skills with git...", "info");
      const result = await scheduler.runNow();
      ctx.ui.notify(formatSyncResult(result), result.status === "error" ? "error" : "info");
    },
  });
}
