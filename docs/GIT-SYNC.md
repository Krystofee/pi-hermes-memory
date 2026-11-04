# Git sync for Hermes memory and skills

Fork-only feature (Krystofee/pi-hermes-memory). Shares Markdown memories,
failure lessons and Hermes-managed skills between Pi machines through one
private Git repository. Local-first: every write lands locally as before; sync
runs in the background and tolerates being offline.

## Non-goals

- No sync of `sessions.db` (conversation history, SQLite index). SQLite stays a
  local, rebuildable mirror of the Markdown files.
- No new storage format. The existing `§`-delimited files stay authoritative.
- No sync of extension code, credentials, config or recovery/lock files.

## Configuration

`~/.pi/agent/hermes-memory-config.json`:

```json
{
  "sync": {
    "repoPath": "~/Repos/pi-hermes-memory-repo",
    "remoteUrl": "git@gitlab.com:krystofee/pi-hermes-memory-repo.git",
    "branch": "main",
    "remoteCheckIntervalSeconds": 300,
    "enabled": true
  }
}
```

Sync is active only when `repoPath` is set, `enabled` is not `false` and the
process is not a memory child (`isMemoryChildProcess()`). `remoteUrl` is used
only to clone a missing `repoPath`. Remote name is always `origin`.

## Repository layout

```
README.md                      human note, never touched by sync
.gitattributes                 managed by sync (see Merging)
global/USER.md                 <- <globalDir>/USER.md
global/MEMORY.md               <- <globalDir>/MEMORY.md
global/failures.md             <- <globalDir>/failures.md
global/STANDING.md             <- <globalDir>/STANDING.md
global/skills/**               <- <globalDir>/skills/**
projects/<name>/MEMORY.md      <- <projectsRoot>/<name>/MEMORY.md
projects/<name>/skills/**      <- <projectsRoot>/<name>/skills/**
conflicts/**                   preserved losing side of non-entry conflicts
```

`globalDir` is the resolved extension memory dir (default
`~/.pi/agent/pi-hermes-memory`), `projectsRoot` is
`<AGENT_ROOT>/<projectsMemoryDir>`. Only those paths are exported. Skipped
everywhere: names starting with `.`, symlinks, non-regular files. Anything
else in a project dir (for example `improvement-backlog.md`) is not synced.

"Entry files" are the four global Markdown stores and every project
`MEMORY.md`. Everything else (skills, assets) is a "plain file". File mode
(executable bit) is preserved both ways.

## Per-machine state

`<repo>/.git/hermes-sync/state.json` (never committed):

- `liveGlobalDir`, `liveProjectsRoot` — if they differ from the running config
  the state is treated as missing (bootstrap).
- `lastImportedCommit` — the commit whose tree equals what was last written to
  the live store. It is the base of every local change.
- `liveSignature` (path -> `size:mtimeMs`) and `liveFingerprint`
  (path -> sha256) of managed live files right after the last import.
- `lastSyncAt`, `lastRemoteCheckAt`, `lastSuccessAt`, `lastError`,
  `pushPending`, `conflicts` (list of conflict copies created by this machine).

Machine-wide lock: `AtomicLockCoordinator` at
`<repo>/.git/hermes-sync/locks.sqlite`, key `sync`. Background triggers skip
when the lock is held; the manual command waits up to 30 s.

## Sync algorithm (one run, under the lock)

1. Ensure repo: clone `remoteUrl` if `repoPath` is missing; fail if it is not a
   Git work tree. Never touch files outside the managed roots.
2. Base checkout: `git checkout -f --detach <lastImportedCommit>` and
   `git clean -ffd`. Without valid state (bootstrap): start an orphan branch with
   an empty tree, so the first merge with the remote is a pure union.
3. Export: replace `global/` and `projects/` in the work tree with the live
   files; write `.gitattributes`. Keep the exported bytes in memory.
4. Secret gate: `scanSecrets()` over every exported text file. Any hit aborts
   the run before commit (`lastError`), nothing is pushed.
5. Commit if the tree changed (`sync: <hostname>`), parent = base. Identity via
   `-c user.name=pi-hermes-sync -c user.email=pi-hermes-sync@<hostname>`,
   `-c commit.gpgsign=false`.
6. `git fetch origin <branch>` (60 s timeout). Failure = offline, continue
   without the remote.
7. Merge, in order, every ref that is not already an ancestor of HEAD: local
   `refs/heads/<branch>` (only after a crash), then `origin/<branch>`.
   `git merge --no-edit -X no-renames [--allow-unrelated-histories]`.
   Resolve conflicts (see Merging) and commit.
8. `git checkout -B <branch>` at the result.
9. Import the result into the live store (see Import), reconcile SQLite.
10. Save state (`lastImportedCommit` = result, fresh signature/fingerprint).
11. If online and the remote is behind: `git push origin <branch>` (never
    force). A rejected push only sets `pushPending`; the next run merges again.

Every step is restartable: a crash before step 10 leaves `lastImportedCommit`
unchanged, so the next run re-exports the live store on top of the same base
and merges again. Git runs with `GIT_TERMINAL_PROMPT=0`; if neither
`GIT_SSH_COMMAND` nor `core.sshCommand` is set, SSH gets
`-o BatchMode=yes -o ConnectTimeout=15`.

## Merging

`.gitattributes` marks entry files `-merge`, so Git never text-merges them;
when both sides changed one, it is left unmerged and resolved in-process from
the index stages (1 base, 2 ours, 3 theirs; a missing stage is empty):

- Entries = file split on `ENTRY_DELIMITER`, trimmed, non-empty. Identity of a
  raw entry for set logic is its exact text including the metadata comment.
- `removed = (base - ours) ∪ (base - theirs)`;
  `result = ours - removed` (keep order) `+ (theirs - base - ours)` (append).
- Dedupe by visible identity (text without metadata + `project64`): keep the
  first position, `created = min`, `last = max`.
- Same entry edited differently on both sides => both new versions survive.
  This is intentional: never lose a write, consolidation can merge them later.

Plain-file conflicts (skills): keep ours in place; write theirs (stage 3) to
`conflicts/<path>~<hostname>~<UTC yyyymmddThhmmssZ>` and record it. Delete vs
modify keeps the modified side. Rename detection is off.

## Import into the live store

For every managed path where exported != result:

- Read the live file now. If it still equals the exported bytes, write the
  result (atomic temp + rename in the same dir, mode preserved) or delete it.
- If it changed during the run: entry files are merged again with
  `base = exported`, `ours = live`, `theirs = result`; plain files keep the live
  version (the next run reconciles it).
- Entry files are read and written under `withMarkdownMutationLock(livePath)`
  so no `MemoryStore` write interleaves. Running stores notice the new
  fingerprint on their next mutation.
- Remove skill directories left empty by deletions.
- Reconcile SQLite with `syncMarkdownMemoriesToSqlite(..., { onlyProjects })`
  for the changed project scopes (global scopes are always checked).

## Scheduling inside the extension

- Startup (`session_start`, after memory init): background run with a remote
  check unless a successful run finished less than 60 s ago (machine-wide).
- Tick every 30 s (`unref`): if the live store is dirty and its signature was
  unchanged since the previous tick, run; otherwise run when
  `now - lastRemoteCheckAt >= remoteCheckIntervalSeconds`.
- Dirty = signature differs from state and content hashes differ too
  (mtime-only changes just refresh the stored signature).
- `session_shutdown`: registered after session flush and before the final DB
  close; if dirty, run with a 15 s deadline; never throws.
- `/memory-git-sync` runs now and reports a short summary.
  `/memory-git-sync status` shows repo, branch, last success/error, dirty,
  pending push and conflicts.
- UI notifications only for the first error after a success and for new
  conflicts. Everything else stays quiet.

## New machine

1. Install the fork package, add the `sync` block with `remoteUrl`.
2. The machine needs its own SSH key with write access to the repo (GitLab
   deploy key with write, generated on that machine).
3. First run bootstraps: union of local and remote content, nothing deleted.
