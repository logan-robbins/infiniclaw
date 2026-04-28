import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { register, type PluginSdk } from "../src/index.js";
import { readJournal } from "../src/directives/journal.js";
import { clearVerifierRegistryForTests } from "../src/verify/pass-registry.js";
import { clearVerifierFailureCountersForTests } from "../src/verify/runner.js";
import { clearDoneRevertStateForTests } from "../src/supervision/done-revert.js";
import type { PluginTool, ToolContext } from "../src/tools/register.js";

const tempRoots: string[] = [];

afterEach(async () => {
  clearVerifierRegistryForTests();
  clearVerifierFailureCountersForTests();
  clearDoneRevertStateForTests();
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin tools", () => {
  it("registers verifier, journal, and task-report tools", () => {
    const tools: PluginTool[] = [];
    register({
      registerTool(tool: PluginTool) {
        tools.push(tool);
      },
    } as PluginSdk);

    expect(tools.map((tool) => tool.name)).toEqual([
      "verifier.run",
      "journal.write_done",
      "journal.set_progress",
      "journal.mark_blocked",
      "report_task_complete",
      "report_task_blocked",
    ]);
  });

  it("runs verifier.run then journal.write_done through registered handlers", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "proof.txt"), "ok\n", "utf8");
    await writeFile(path.join(dir, "DIRECTIVES.md"), directives(), "utf8");
    await writeFile(path.join(dir, "JOURNAL.md"), journal(), "utf8");

    const tools: PluginTool[] = [];
    register({
      registerTool(tool: PluginTool) {
        tools.push(tool);
      },
    } as PluginSdk);

    const verifierRun = tools.find((tool) => tool.name === "verifier.run")!;
    const writeDone = tools.find((tool) => tool.name === "journal.write_done")!;
    const ctx: ToolContext = {
      agentId: "agent-tools",
      sessionKey: "session-tools",
      workspaceDir: dir,
    };

    const runResult = await verifierRun.handler({ step_id: "step-1" }, ctx);
    expect(runResult).toMatchObject({ allPass: true });

    const doneResult = await writeDone.handler(
      { step_id: "step-1", verified_outputs: ["proof.txt"] },
      ctx,
    );
    expect(doneResult).toMatchObject({ ok: true, step_id: "step-1", status: "DONE" });

    const after = await readJournal(path.join(dir, "JOURNAL.md"));
    expect(after.taskStack[0]).toMatchObject({
      status: "DONE",
      verifiedOutputs: ["proof.txt"],
      blackBox: true,
    });

    const events = await readEvents(dir);
    expect(events.map((event) => event.event)).toContain("AGENT:VERIFIER_RUN");
    expect(events.map((event) => event.event)).toContain("AGENT:STEP_COMPLETE");
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-tools-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function readEvents(dir: string): Promise<Array<{ event: string }>> {
  return (await readFile(path.join(dir, ".agent-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string });
}

function directives(): string {
  return `# DIRECTIVES (immutable for this agent's lifetime)
schema_version: 1
agent: agent-tools
parent: main
workspace: /workspace/tools
spawned: 2026-04-27T00:00:00Z
journal: ./JOURNAL.md

## GOAL
Prove tool registration.

## INPUT CONTRACT
# (empty)

## OUTPUT CONTRACT
- kind: file
  path: proof.txt
  exports: []
  interface: "proof output"

## DEFINITION OF DONE
- type: file_exists
  path: proof.txt

## CONSTRAINTS
# (none)

## TURN BUDGET
max_turns: 10
warning_at: 8
escalate_at: 9

## INITIAL DECOMPOSITION
- step-1: Check proof file

## PROTOCOL
You are an OpenClaw agent under the Persistent Directive System.
`;
}

function journal(): string {
  return `# JOURNAL
schema_version: 1
agent: agent-tools
last_updated: 2026-04-27T00:00:00Z
turns_used: 0
last_verifier_run: null

## TASK STACK

#### step-1: Check proof file
status: IN_PROGRESS
started: 2026-04-27T00:00:00Z

## WORKING NOTES
# (empty)

## SUB-AGENTS
# (empty)

## COMPLETION REPORT
# (empty)
`;
}
