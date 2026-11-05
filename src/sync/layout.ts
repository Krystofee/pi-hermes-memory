/**
 * Mapping between the live Hermes store and the sync repository work tree.
 *
 * The repository mirrors a fixed allowlist of live paths (docs/GIT-SYNC.md →
 * Repository layout). Everything outside it, including sessions.db, recovery
 * snapshots, lock databases and any unexpected file, is neither exported nor
 * written back, so a bad commit cannot reach arbitrary paths on a machine.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withMarkdownMutationLock } from "../store/markdown-mutation-lock.js";
import { mergeEntryText, type EntryFormat } from "./entry-merge.js";

export interface LiveRoots {
  /** Extension memory dir, e.g. ~/.pi/agent/pi-hermes-memory */
  globalDir: string;
  /** <agentRoot>/<projectsMemoryDir>, e.g. ~/.pi/agent/projects-memory */
  projectsRoot: string;
}

/** Git tracks only the executable bit, so modes are normalized to these two. */
export type FileMode = 0o644 | 0o755;

export interface TreeFile {
  content: Buffer;
  mode: FileMode;
}

/** Repository-relative POSIX path → file. */
export type SyncTree = Map<string, TreeFile>;

export interface ImportReport {
  /** Live paths overwritten or deleted with the merged result. */
  applied: string[];
  /** Entry files written during the run by someone else, merged again. */
  mergedConcurrent: string[];
  /** Plain files changed live during the run; left for the next run. */
  keptLocal: string[];
  /** Memory scopes whose Markdown changed, for the SQLite reconcile. */
  memoryScopes: { global: boolean; projects: string[] };
}

const GLOBAL_ENTRY_FILES: Record<string, EntryFormat> = {
  "USER.md": "section",
  "MEMORY.md": "section",
  "failures.md": "section",
  "STANDING.md": "line",
};
const PROJECT_MEMORY_FILE = "MEMORY.md";
const SKILLS_DIR = "skills";

function isPlainSegment(segment: string): boolean {
  return segment.length > 0 && !segment.startsWith(".") && !segment.includes("\\");
}

export function entryFormatFor(relPath: string): EntryFormat | null {
  const parts = relPath.split("/");
  if (parts.length === 2 && parts[0] === "global") return GLOBAL_ENTRY_FILES[parts[1]] ?? null;
  if (parts.length === 3 && parts[0] === "projects" && parts[2] === PROJECT_MEMORY_FILE) return "section";
  return null;
}

export function isManagedPath(relPath: string): boolean {
  const parts = relPath.split("/");
  if (!parts.every(isPlainSegment)) return false;
  if (parts[0] === "global") {
    return (parts.length === 2 && parts[1] in GLOBAL_ENTRY_FILES)
      || (parts.length >= 3 && parts[1] === SKILLS_DIR);
  }
  if (parts[0] === "projects" && parts.length >= 3) {
    return (parts.length === 3 && parts[2] === PROJECT_MEMORY_FILE)
      || (parts.length >= 4 && parts[2] === SKILLS_DIR);
  }
  return false;
}

export function livePathFor(roots: LiveRoots, relPath: string): string {
  if (!isManagedPath(relPath)) throw new Error(`Not a managed sync path: ${relPath}`);
  const [root, ...rest] = relPath.split("/");
  return root === "global"
    ? path.join(roots.globalDir, ...rest)
    : path.join(roots.projectsRoot, ...rest);
}

/** The skills root a deleted skill file may prune empty directories up to. */
function skillsRootFor(roots: LiveRoots, relPath: string): string | null {
  const parts = relPath.split("/");
  if (parts[0] === "global" && parts[1] === SKILLS_DIR) return path.join(roots.globalDir, SKILLS_DIR);
  if (parts[0] === "projects" && parts[2] === SKILLS_DIR) return path.join(roots.projectsRoot, parts[1], SKILLS_DIR);
  return null;
}

export function sameFile(left: TreeFile | undefined, right: TreeFile | undefined): boolean {
  if (!left || !right) return left === right;
  return left.mode === right.mode && left.content.equals(right.content);
}

function normalizeMode(mode: number): FileMode {
  return (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/** Regular files only: a symlink or directory at the path counts as absent. */
async function readRegularFile(filePath: string): Promise<TreeFile | undefined> {
  let state;
  try {
    state = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!state.isFile()) return undefined;
  return { content: await fs.readFile(filePath), mode: normalizeMode(state.mode) };
}

async function isSymlinkOrSpecial(filePath: string): Promise<boolean> {
  try {
    return !(await fs.lstat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Recursively collect regular files, skipping dot names and symlinks. */
async function collectFiles(dir: string, relPrefix: string, out: SyncTree): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!isPlainSegment(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(fullPath, relPath, out);
    } else if (entry.isFile()) {
      const file = await readRegularFile(fullPath);
      if (file) out.set(relPath, file);
    }
  }
}

/** Snapshot of every managed live file. */
export async function exportLiveTree(roots: LiveRoots): Promise<SyncTree> {
  const tree: SyncTree = new Map();
  for (const name of Object.keys(GLOBAL_ENTRY_FILES)) {
    const file = await readRegularFile(path.join(roots.globalDir, name));
    if (file) tree.set(`global/${name}`, file);
  }
  await collectFiles(path.join(roots.globalDir, SKILLS_DIR), `global/${SKILLS_DIR}`, tree);

  let projects: Dirent[];
  try {
    projects = await fs.readdir(roots.projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    projects = [];
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  for (const project of projects) {
    if (!project.isDirectory() || !isPlainSegment(project.name)) continue;
    const projectDir = path.join(roots.projectsRoot, project.name);
    const memory = await readRegularFile(path.join(projectDir, PROJECT_MEMORY_FILE));
    if (memory) tree.set(`projects/${project.name}/${PROJECT_MEMORY_FILE}`, memory);
    await collectFiles(path.join(projectDir, SKILLS_DIR), `projects/${project.name}/${SKILLS_DIR}`, tree);
  }
  return tree;
}

/** Replace the managed roots of a work tree with `tree`. */
export async function writeWorkTree(workTree: string, tree: SyncTree): Promise<void> {
  await fs.rm(path.join(workTree, "global"), { recursive: true, force: true });
  await fs.rm(path.join(workTree, "projects"), { recursive: true, force: true });
  for (const [relPath, file] of tree) {
    if (!isManagedPath(relPath)) throw new Error(`Refusing to write unmanaged path: ${relPath}`);
    const target = path.join(workTree, ...relPath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, { mode: file.mode });
    await fs.chmod(target, file.mode);
  }
}

/** Managed files of a work tree; anything else a commit might carry is ignored. */
export async function readWorkTree(workTree: string): Promise<SyncTree> {
  const collected: SyncTree = new Map();
  await collectFiles(path.join(workTree, "global"), "global", collected);
  await collectFiles(path.join(workTree, "projects"), "projects", collected);
  const tree: SyncTree = new Map();
  for (const [relPath, file] of collected) {
    if (isManagedPath(relPath)) tree.set(relPath, file);
  }
  return tree;
}

async function writeLiveFile(filePath: string, file: TreeFile): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.hermes-sync-${process.pid}-${randomUUID()}`);
  try {
    await fs.writeFile(tmpPath, file.content, { mode: file.mode });
    await fs.chmod(tmpPath, file.mode);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
}

async function removeEmptyParents(startDir: string, stopDir: string): Promise<void> {
  let current = startDir;
  while (current !== stopDir && current.startsWith(stopDir + path.sep)) {
    try {
      await fs.rmdir(current);
    } catch {
      return; // not empty (or already gone): stop pruning
    }
    current = path.dirname(current);
  }
}

async function applyLive(roots: LiveRoots, relPath: string, livePath: string, result: TreeFile | undefined): Promise<void> {
  if (result) {
    await writeLiveFile(livePath, result);
    return;
  }
  await fs.rm(livePath, { force: true });
  const skillsRoot = skillsRootFor(roots, relPath);
  if (skillsRoot) await removeEmptyParents(path.dirname(livePath), skillsRoot);
}

/**
 * Write the merged result back to the live store. `exported` is what this run
 * read from the live store; a live file that no longer matches it was written
 * during the run and must not be overwritten blindly.
 */
export async function importTree(roots: LiveRoots, exported: SyncTree, result: SyncTree): Promise<ImportReport> {
  const report: ImportReport = { applied: [], mergedConcurrent: [], keptLocal: [], memoryScopes: { global: false, projects: [] } };
  const projects = new Set<string>();
  const touchMemoryScope = (relPath: string) => {
    const parts = relPath.split("/");
    if (parts[0] === "global") report.memoryScopes.global = true;
    else projects.add(parts[1]);
  };

  const paths = [...new Set([...exported.keys(), ...result.keys()])].sort();
  for (const relPath of paths) {
    const before = exported.get(relPath);
    const after = result.get(relPath);
    if (sameFile(before, after)) continue;

    const livePath = livePathFor(roots, relPath);
    const format = entryFormatFor(relPath);

    if (!format) {
      if (await isSymlinkOrSpecial(livePath)) {
        report.keptLocal.push(relPath);
        continue;
      }
      const current = await readRegularFile(livePath);
      if (sameFile(current, before)) {
        await applyLive(roots, relPath, livePath, after);
        report.applied.push(relPath);
      } else {
        report.keptLocal.push(relPath);
      }
      continue;
    }

    await withMarkdownMutationLock(livePath, async () => {
      if (await isSymlinkOrSpecial(livePath)) {
        report.keptLocal.push(relPath);
        return;
      }
      const current = await readRegularFile(livePath);
      if (sameFile(current, before)) {
        await applyLive(roots, relPath, livePath, after);
        report.applied.push(relPath);
      } else {
        const merged = mergeEntryText(
          before?.content.toString("utf-8") ?? null,
          current?.content.toString("utf-8") ?? null,
          after?.content.toString("utf-8") ?? null,
          format,
        );
        await writeLiveFile(livePath, { content: Buffer.from(merged, "utf-8"), mode: current?.mode ?? after?.mode ?? 0o644 });
        report.mergedConcurrent.push(relPath);
      }
      touchMemoryScope(relPath);
    });
  }

  report.memoryScopes.projects = [...projects].sort();
  return report;
}
