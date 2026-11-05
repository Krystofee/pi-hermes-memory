/**
 * Machine signatures: entries and skills written on one machine cannot be
 * rewritten by another machine's agent unless the user explicitly asks.
 * Two "machines" share one store directory here, as they do after a sync.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { parseMarkdownMemoryEntry } from "../../src/store/sqlite-memory-store.js";
import { registerSkillTool } from "../../src/tools/skill-tool.js";
import { buildPromptContext } from "../../src/prompt-context.js";
import { defaultMachineName, entryOwner, signEntry } from "../../src/sync/signature.js";
import type { MemoryConfig } from "../../src/types.js";
import { rmTestDir } from "../helpers/cleanup.js";

let tmp = "";

function config(memoryDir: string, machineName?: string): MemoryConfig {
  return {
    memoryMode: "policy-only", memoryCharLimit: 100_000, userCharLimit: 100_000, projectCharLimit: 100_000,
    nudgeInterval: 10, reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false, flushMinTurns: 6,
    autoConsolidate: false, correctionDetection: false, failureInjectionEnabled: false,
    failureInjectionMaxAgeDays: 7, failureInjectionMaxEntries: 5, nudgeToolCalls: 15, memoryDir,
    sync: machineName
      ? { repoPath: path.join(tmp, "repo"), branch: "main", remoteCheckIntervalSeconds: 300, enabled: true, machineName }
      : undefined,
  };
}

async function store(machineName?: string, dir = path.join(tmp, "memory")): Promise<MemoryStore> {
  const created = new MemoryStore(config(dir, machineName));
  await created.loadFromDisk();
  return created;
}

async function visible(file: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(tmp, "memory", file), "utf-8");
  return raw.split(ENTRY_DELIMITER).map((entry) => entry.replace(/\s*<!--.*-->$/s, "").trim());
}

function skillTool(machineName: string | null) {
  const skills = new SkillStore({
    globalSkillsDir: path.join(tmp, "skills"),
    piGlobalSkillsDir: path.join(tmp, "pi-skills"),
    projectSkillsDir: null,
    projectName: null,
    legacySkillsDir: path.join(tmp, "legacy"),
    migrationSentinelPath: path.join(tmp, ".migrated"),
    machineName,
  });
  let tool: any;
  registerSkillTool({ registerTool: (definition: any) => { tool = definition; } } as any, skills);
  const call = async (params: Record<string, unknown>) =>
    JSON.parse((await tool.execute("id", params, undefined, undefined, {})).content[0].text);
  return { skills, call };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-signature-"));
});

afterEach(async () => {
  await rmTestDir(tmp);
});

describe("signature text", () => {
  it("signs after the lesson category, replaces a typed signature and reads the owner back", () => {
    assert.equal(signEntry("Node 16 lives in nvm", "Macbook"), "[@Macbook] Node 16 lives in nvm");
    assert.equal(signEntry("[tool-quirk] glab needs a header", "devvm"), "[tool-quirk] [@devvm] glab needs a header");
    assert.equal(signEntry("[@Macbook] forged by devvm", "devvm"), "[@devvm] forged by devvm");
    assert.equal(signEntry("[insight] [@devvm] fact", "devvm"), "[insight] [@devvm] fact");
    assert.equal(entryOwner("[correction] [@devvm] fact"), "devvm");
    assert.equal(entryOwner("[@Macbook] fact"), "Macbook");
    assert.equal(entryOwner("plain fact"), null);
    assert.equal(entryOwner("[not-a-category] [@x] fact"), null);
    assert.equal(defaultMachineName("MacBook-Pro-3.local"), "MacBook-Pro-3");
  });
});

describe("memory ownership", () => {
  it("signs every write and keeps the lesson category parseable", async () => {
    const mac = await store("Macbook");
    await mac.add("memory", "Node 16 is at ~/.nvm");
    await mac.addFailure("GNU timeout is missing", { category: "tool-quirk", project: "retino" });
    await mac.add("user", "Prefers Czech");
    assert.deepEqual(await visible("MEMORY.md"), ["[@Macbook] Node 16 is at ~/.nvm"]);
    assert.deepEqual(await visible("USER.md"), ["[@Macbook] Prefers Czech"]);
    const [failure] = (await fs.readFile(path.join(tmp, "memory", "failures.md"), "utf-8")).split(ENTRY_DELIMITER);
    const parsed = parseMarkdownMemoryEntry(failure, "failure", "retino");
    assert.equal(parsed.category, "tool-quirk");
    assert.equal(parsed.content, "[tool-quirk] [@Macbook] GNU timeout is missing");
  });

  it("refuses to replace or remove another machine's entry and lets it add its own", async () => {
    const mac = await store("Macbook");
    await mac.add("memory", "Node 16 is at ~/.nvm");
    await mac.addFailure("ports 8001/9001 are free", { category: "insight" });
    const devvm = await store("devvm");

    const replaced = await devvm.replace("memory", "Node 16 is at", "Node 22 is at /usr/local");
    assert.equal(replaced.success, false);
    assert.match(replaced.error!, /belongs to machine 'Macbook' and this machine is 'devvm'/);
    assert.match(replaced.error!, /memory_add/);
    const removed = await devvm.remove("failure", "ports 8001/9001");
    assert.equal(removed.success, false);
    assert.match(removed.error!, /override_owner=true/);

    assert.equal((await devvm.add("memory", "Node 22 is at /usr/local")).success, true);
    assert.deepEqual(await visible("MEMORY.md"), ["[@Macbook] Node 16 is at ~/.nvm", "[@devvm] Node 22 is at /usr/local"]);

    // The same text added on both machines stays two signed entries.
    assert.equal((await devvm.add("memory", "Node 16 is at ~/.nvm")).success, true);
    assert.equal((await visible("MEMORY.md")).length, 3);
  });

  it("lets the owner change its entries and keeps it the owner", async () => {
    const mac = await store("Macbook");
    await mac.add("memory", "Retino runs on port 8000");
    assert.equal((await mac.replace("memory", "port 8000", "[@devvm] Retino runs on port 8001")).success, true);
    assert.deepEqual(await visible("MEMORY.md"), ["[@Macbook] Retino runs on port 8001"]);
    assert.equal((await mac.remove("memory", "port 8001")).success, true);
  });

  it("an explicit override edits another machine's entry under that machine's name", async () => {
    const mac = await store("Macbook");
    await mac.add("memory", "Docker runs in Colima");
    const devvm = await store("devvm");
    const result = await devvm.replace("memory", "Colima", "Docker runs in Docker Desktop", undefined, { overrideOwner: true });
    assert.equal(result.success, true);
    assert.deepEqual(await visible("MEMORY.md"), ["[@Macbook] Docker runs in Docker Desktop"]);
    assert.equal((await devvm.remove("memory", "Docker Desktop", undefined, { overrideOwner: true })).success, true);
  });

  it("keeps USER.md open to every machine and signs the last writer", async () => {
    const mac = await store("Macbook");
    await mac.add("user", "Prefers short answers");
    const devvm = await store("devvm");
    assert.equal((await devvm.replace("user", "short answers", "Prefers short answers in Czech")).success, true);
    assert.deepEqual(await visible("USER.md"), ["[@devvm] Prefers short answers in Czech"]);
  });

  it("treats unsigned entries as shared and signs them on the next change", async () => {
    await fs.mkdir(path.join(tmp, "memory"), { recursive: true });
    await fs.writeFile(path.join(tmp, "memory", "MEMORY.md"), "Legacy fact <!-- created=2026-01-01, last=2026-01-01 -->");
    const devvm = await store("devvm");
    assert.equal((await devvm.replace("memory", "Legacy fact", "Legacy fact, checked")).success, true);
    assert.deepEqual(await visible("MEMORY.md"), ["[@devvm] Legacy fact, checked"]);
  });

  it("refuses a consolidation plan that touches another machine's entries, atomically", async () => {
    const mac = await store("Macbook");
    await mac.add("memory", "mac fact one");
    const devvm = await store("devvm");
    await devvm.add("memory", "devvm fact one");
    await devvm.add("memory", "devvm fact two");
    const before = await fs.readFile(path.join(tmp, "memory", "MEMORY.md"), "utf-8");

    const refused = await devvm.applyMutationPlan("memory", [
      { action: "remove", oldText: "devvm fact two" },
      { action: "replace", oldText: "mac fact one", content: "merged facts" },
    ]);
    assert.equal(refused.success, false);
    assert.match(refused.error!, /belongs to machine 'Macbook'/);
    assert.equal(await fs.readFile(path.join(tmp, "memory", "MEMORY.md"), "utf-8"), before);

    const own = await devvm.applyMutationPlan("memory", [
      { action: "remove", oldText: "devvm fact two" },
      { action: "replace", oldText: "devvm fact one", content: "devvm facts one and two" },
      { action: "add", content: "devvm fact three" },
    ]);
    assert.equal(own.success, true, own.error);
    assert.deepEqual(await visible("MEMORY.md"), ["[@Macbook] mac fact one", "[@devvm] devvm facts one and two", "[@devvm] devvm fact three"]);
  });

  it("without sync configured nothing is signed or locked (upstream behaviour)", async () => {
    const plain = await store();
    await plain.add("memory", "[@Macbook] typed by hand");
    assert.equal((await plain.replace("memory", "typed by hand", "edited")).success, true);
    assert.deepEqual(await visible("MEMORY.md"), ["edited"]);
  });
});

describe("skill ownership", () => {
  const create = {
    action: "create", scope: "global", name: "start-dev-server",
    description: "Start the development server on this machine",
    when_to_use: "Before E2E checks.", procedure_steps: ["scripts/dev-lane up"], verification_steps: ["Port answers"],
  };

  it("records the author and lets another machine only add its own notes", async () => {
    const mac = skillTool("Macbook");
    assert.equal((await mac.call(create)).success, true);
    assert.equal((await mac.skills.loadSkill("global:start-dev-server"))!.author, "Macbook");
    assert.match(await fs.readFile(path.join(tmp, "skills", "start-dev-server", "SKILL.md"), "utf-8"), /^author: "Macbook"$/m);

    const devvm = skillTool("devvm");
    const patched = await devvm.call({ action: "patch", skill_id: "global:start-dev-server", section: "Procedure", procedure_steps: ["rdev up"] });
    assert.equal(patched.success, false);
    assert.match(patched.error, /belongs to machine 'Macbook'.*Notes \(devvm\)/s);
    assert.equal((await devvm.call({ action: "update", skill_id: "global:start-dev-server", content: "rewritten" })).success, false);
    assert.equal((await devvm.call({ action: "delete", skill_id: "global:start-dev-server" })).success, false);

    const notes = await devvm.call({ action: "patch", skill_id: "global:start-dev-server", section: "Notes (devvm)", content: "On devvm use `rdev up` instead." });
    assert.equal(notes.success, true, notes.error);
    const doc = (await devvm.skills.loadSkill("global:start-dev-server"))!;
    assert.equal(doc.author, "Macbook");
    assert.match(doc.body, /1\. scripts\/dev-lane up/);
    assert.match(doc.body, /## Notes \(devvm\)\nOn devvm use `rdev up` instead\./);

    // The author keeps full control, and an explicit override works for others.
    assert.equal((await mac.call({ action: "patch", skill_id: "global:start-dev-server", section: "Procedure", procedure_steps: ["scripts/dev-lane up --entries dashboard"] })).success, true);
    assert.equal((await mac.skills.loadSkill("global:start-dev-server"))!.author, "Macbook");
    assert.equal((await devvm.call({ action: "delete", skill_id: "global:start-dev-server", override_owner: true })).success, true);
  });

  it("leaves unsigned skills shared", async () => {
    const legacy = skillTool(null);
    assert.equal((await legacy.call(create)).success, true);
    assert.equal((await legacy.skills.loadSkill("global:start-dev-server"))!.author, undefined);
    const devvm = skillTool("devvm");
    assert.equal((await devvm.call({ action: "patch", skill_id: "global:start-dev-server", section: "Procedure", procedure_steps: ["rdev up"] })).success, true);
  });
});

describe("prompt", () => {
  it("tells the agent which machine it is on, also in memory children", async () => {
    const mac = await store("Macbook");
    const cfg = { ...config(path.join(tmp, "memory"), "Macbook"), memoryPolicyStyle: "compact" as const };
    for (const forChild of [false, true]) {
      const prompt = await buildPromptContext(cfg, mac, null, "", null, forChild);
      assert.match(prompt, /This machine is 'Macbook'/);
      assert.match(prompt, /Notes \(Macbook\)/);
    }
    assert.doesNotMatch(await buildPromptContext(config(path.join(tmp, "memory")), mac, null, ""), /memory-machine/);
  });
});
