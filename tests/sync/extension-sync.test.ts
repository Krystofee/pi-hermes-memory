/**
 * End-to-end through the real extension entry point: two "machines" register
 * the extension with their own memory dirs and sync repos, write through the
 * real memory_* and skill_manage tool handlers, and sync with /memory-git-sync.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rmTestDir } from "../helpers/cleanup.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sync-extension-")));
const previousRoot = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { default: registerExtension } = await import("../../src/index.js");
const { MEMORY_CHILD_ENV_VAR } = await import("../../src/handlers/pi-child-process.js");

const remote = path.join(root, "remote.git");
const cwd = path.join(root, "workspace");

interface Session {
  name: string;
  memoryDir: string;
  projectsDir: string;
  repoPath: string;
  handlers: Record<string, Array<(event: any, ctx: any) => any>>;
  tools: Record<string, any>;
  commands: Record<string, any>;
  notifications: string[];
  ctx: any;
}

const sessions: Session[] = [];

async function writeConfig(name: string, extra: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(root, "hermes-memory-config.json"), JSON.stringify({
    memoryDir: path.join(root, "machines", name, "pi-hermes-memory"),
    projectsMemoryDir: `projects-${name}`,
    reviewEnabled: false,
    correctionDetection: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    quickCheckOnOpen: false,
    sync: { repoPath: path.join(root, "machines", name, "repo"), remoteUrl: remote },
    ...extra,
  }));
}

/** Register the extension as a machine; config is read at registration. */
async function start(name: string, extra: Record<string, unknown> = {}): Promise<Session> {
  await writeConfig(name, extra);
  const session: Session = {
    name,
    memoryDir: path.join(root, "machines", name, "pi-hermes-memory"),
    projectsDir: path.join(root, `projects-${name}`),
    repoPath: path.join(root, "machines", name, "repo"),
    handlers: {},
    tools: {},
    commands: {},
    notifications: [],
    ctx: null,
  };
  session.ctx = {
    cwd,
    hasUI: true,
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    ui: { notify: (text: string) => session.notifications.push(text) },
  };
  registerExtension({
    on(event: string, handler: any) { (session.handlers[event] ??= []).push(handler); },
    registerTool(tool: any) { session.tools[tool.name] = tool; },
    registerCommand(command: string, options: any) { session.commands[command] = options; },
  } as any);
  sessions.push(session);
  await emit(session, "session_start");
  return session;
}

async function emit(session: Session, event: string, data: any = {}) {
  let result: any;
  for (const handler of session.handlers[event] ?? []) result = (await handler(data, session.ctx)) ?? result;
  return result;
}

async function tool(session: Session, name: string, params: Record<string, unknown>): Promise<any> {
  const result = await session.tools[name].execute("call", params, undefined, undefined, session.ctx);
  const text = result.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function ok(session: Session, name: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool(session, name, params);
  assert.notEqual(result.success, false, `${session.name} ${name} failed: ${JSON.stringify(result)}`);
  return result;
}

async function sync(session: Session): Promise<string> {
  const before = session.notifications.length;
  await session.commands["memory-git-sync"].handler("", session.ctx);
  const output = session.notifications.slice(before).join("\n");
  assert.match(output, /✅ Hermes git sync/, `${session.name}: ${output}`);
  return output;
}

async function searchText(session: Session, query: string, target?: string): Promise<string> {
  const result = await tool(session, "memory_search", target ? { query, target } : { query });
  return JSON.stringify(result);
}

before(async () => {
  await fs.mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await emit(session, "session_shutdown", { reason: "quit" });
});

after(async () => {
  if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousRoot;
  await rmTestDir(root);
});

describe("git sync through the extension", () => {
  it("moves memories, lessons, project memory and skills between machines in both directions", async () => {
    const a = await start("mac");
    const b = await start("dell");

    await ok(a, "memory_add", { target: "user", content: "Kryštof wants concise Czech answers" });
    await ok(a, "memory_add", { target: "memory", content: "Sync repo is ~/Repos/pi-hermes-memory-repo" });
    await ok(a, "memory_add", { target: "memory", content: "Temporary note to delete" });
    await ok(a, "memory_add", { target: "failure", category: "tool-quirk", content: "glab api JSON writes need an explicit content type" });
    await ok(a, "memory_add", { target: "project", content: "Workspace project uses dev-lane ports 8001/9001" });
    await ok(a, "memory_replace", { target: "memory", old_text: "Sync repo is", content: "Sync repo is ~/Repos/pi-hermes-memory-repo on GitLab (private)" });
    await ok(a, "memory_remove", { target: "memory", old_text: "Temporary note to delete" });
    await ok(a, "skill_manage", {
      action: "create", scope: "global", name: "rotate-sync-deploy-key",
      description: "Rotate the per-machine deploy key of the memory sync repository",
      when_to_use: "A machine's sync deploy key leaked or the machine was retired.",
      verification_steps: ["The machine pushes with the new key"],
      procedure_steps: ["Generate a key on the machine", "Add it as a write deploy key"],
    });
    await ok(a, "skill_manage", {
      action: "create", scope: "project", name: "workspace-dev-lane",
      description: "Start the workspace dev lane for screenshots",
      when_to_use: "Screenshots of the workspace need a running lane.",
      verification_steps: ["The lane answers on port 8001"],
      procedure_steps: ["scripts/dev-lane up"],
    });

    assert.match(await sync(a), /pushed/);
    await sync(b);

    assert.match(await fs.readFile(path.join(b.memoryDir, "USER.md"), "utf-8"), /concise Czech answers/);
    const bMemory = await fs.readFile(path.join(b.memoryDir, "MEMORY.md"), "utf-8");
    assert.match(bMemory, /on GitLab \(private\)/);
    assert.doesNotMatch(bMemory, /Temporary note/);
    assert.match(await fs.readFile(path.join(b.memoryDir, "failures.md"), "utf-8"), /\[tool-quirk\] glab api/);
    assert.match(await fs.readFile(path.join(b.projectsDir, "workspace", "MEMORY.md"), "utf-8"), /dev-lane ports/);
    assert.match(await searchText(b, "concise", "user"), /concise Czech answers/);
    assert.match(await searchText(b, "GitLab"), /private/);
    assert.doesNotMatch(await searchText(b, "Temporary"), /Temporary note/);
    assert.match(await searchText(b, "content type", "failure"), /glab api/);
    assert.match(await searchText(b, "ports", "project"), /dev-lane/);
    assert.match(JSON.stringify(await ok(b, "skill_manage", { action: "view", skill_id: "global:rotate-sync-deploy-key" })), /write deploy key/);
    assert.match(JSON.stringify(await ok(b, "skill_manage", { action: "view", skill_id: "project:workspace:workspace-dev-lane" })), /dev-lane up/);

    // Back from the other machine.
    await ok(b, "memory_add", { target: "memory", content: "Dell joined the memory sync" });
    await ok(b, "memory_add", { target: "failure", category: "correction", content: "Never print the deploy key" });
    await ok(b, "skill_manage", {
      action: "patch", skill_id: "global:rotate-sync-deploy-key", section: "Pitfalls",
      pitfalls: ["Read-only deploy keys cannot push"],
    });
    await ok(b, "skill_manage", { action: "delete", skill_id: "project:workspace:workspace-dev-lane" });
    await sync(b);
    await sync(a);

    assert.match(await searchText(a, "joined"), /Dell joined the memory sync/);
    assert.match(await searchText(a, "deploy key", "failure"), /Never print the deploy key/);
    assert.match(JSON.stringify(await ok(a, "skill_manage", { action: "view", skill_id: "global:rotate-sync-deploy-key" })), /Read-only deploy keys cannot push/);
    assert.equal(existsSync(path.join(a.projectsDir, "workspace", "skills", "workspace-dev-lane")), false);

    // Memory written after a sync goes through the same tool path and keeps working.
    await ok(a, "memory_add", { target: "memory", content: "Written after importing remote changes" });
    await ok(a, "memory_remove", { target: "memory", old_text: "Dell joined the memory sync" });
    await sync(a);
    await sync(b);
    assert.doesNotMatch(await searchText(b, "joined"), /Dell joined/);
    assert.match(await searchText(b, "importing"), /Written after importing/);

    await a.commands["memory-git-sync"].handler("status", a.ctx);
    const status = a.notifications.at(-1)!;
    assert.match(status, /Last success: \d{4}-/);
    assert.match(status, /Local changes waiting: no/);
    assert.match(status, /Conflicts: none/);

    const remoteFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: remote, encoding: "utf-8" });
    assert.doesNotMatch(remoteFiles, /sessions\.db|\.pi-hermes-locks|recovery/);
  });

  it("pushes on session shutdown", async () => {
    const a = await start("mac");
    await sync(a);
    await ok(a, "memory_add", { target: "memory", content: "Written right before quitting" });
    await emit(a, "session_shutdown", { reason: "quit" });
    sessions.splice(sessions.indexOf(a), 1);
    const remoteMemory = execFileSync("git", ["show", "main:global/MEMORY.md"], { cwd: remote, encoding: "utf-8" });
    assert.match(remoteMemory, /Written right before quitting/);
  });

  it("does not sync or register the command in a memory child process or when disabled", async () => {
    const previous = process.env[MEMORY_CHILD_ENV_VAR];
    process.env[MEMORY_CHILD_ENV_VAR] = "1";
    try {
      const child = await start("child");
      assert.equal(child.commands["memory-git-sync"], undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(child.repoPath), false);
    } finally {
      if (previous === undefined) delete process.env[MEMORY_CHILD_ENV_VAR];
      else process.env[MEMORY_CHILD_ENV_VAR] = previous;
    }
    const disabled = await start("disabled", { sync: { repoPath: path.join(root, "machines", "disabled", "repo"), remoteUrl: remote, enabled: false } });
    assert.equal(disabled.commands["memory-git-sync"], undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(disabled.repoPath), false);
  });
});
