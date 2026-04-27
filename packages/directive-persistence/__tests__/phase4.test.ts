import crypto from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TaskCompleteValidationError,
  reVerifyChildClaim,
  type TaskCompleteReport,
  validateTaskComplete,
} from "../src/spawn/parse-task-complete.js";
import { spawnChildDirectives } from "../src/spawn/write-child-directives.js";
import {
  clearVerifierFailureCountersForTests,
  runDoDForStep,
} from "../src/verify/runner.js";
import { clearVerifierRegistryForTests } from "../src/verify/pass-registry.js";

const tempRoots: string[] = [];

afterEach(async () => {
  clearVerifierRegistryForTests();
  clearVerifierFailureCountersForTests();
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Phase 4 sub-agent recursion", () => {
  it("main → 2 parallel sub-agents — both complete and events flow to shared log", async () => {
    const root = await tempDir();

    const [childA, childB] = await Promise.all([
      spawnChildDirectives({
        parentWorkspaceDir: root,
        childId: "sub-work-a",
        directivesContent: subDirectives("sub:work-a:0001", "output-a.txt"),
        parentAgent: "main",
      }),
      spawnChildDirectives({
        parentWorkspaceDir: root,
        childId: "sub-work-b",
        directivesContent: subDirectives("sub:work-b:0002", "output-b.txt"),
        parentAgent: "main",
      }),
    ]);

    await writeFile(path.join(childA.childWorkspaceDir, "output-a.txt"), "result-a\n", "utf8");
    await writeFile(path.join(childB.childWorkspaceDir, "output-b.txt"), "result-b\n", "utf8");

    const ctxA = { workspaceDir: childA.childWorkspaceDir, agent: "sub:work-a:0001" };
    const ctxB = { workspaceDir: childB.childWorkspaceDir, agent: "sub:work-b:0002" };

    const runA = await runDoDForStep(
      "step-final",
      [{ type: "file_exists", path: "output-a.txt" }],
      ctxA,
    );
    const runB = await runDoDForStep(
      "step-final",
      [{ type: "file_exists", path: "output-b.txt" }],
      ctxB,
    );

    expect(runA.allPass).toBe(true);
    expect(runB.allPass).toBe(true);

    const shaA = await sha256OfFile(path.join(childA.childWorkspaceDir, "output-a.txt"));
    const shaB = await sha256OfFile(path.join(childB.childWorkspaceDir, "output-b.txt"));

    const reportA: TaskCompleteReport = {
      outputs: [{ kind: "file", path: "output-a.txt", sha256: shaA }],
      dod_evidence: [{ criterion_index: 0, verifier_run_id: runA.verifierRunId, result: "PASS" }],
      service_card_proposal: null,
    };
    const reportB: TaskCompleteReport = {
      outputs: [{ kind: "file", path: "output-b.txt", sha256: shaB }],
      dod_evidence: [{ criterion_index: 0, verifier_run_id: runB.verifierRunId, result: "PASS" }],
      service_card_proposal: null,
    };

    await validateTaskComplete({
      report: reportA,
      agent: "sub:work-a:0001",
      directivesPath: childA.directivesPath,
      workspaceDir: childA.childWorkspaceDir,
    });
    await validateTaskComplete({
      report: reportB,
      agent: "sub:work-b:0002",
      directivesPath: childB.directivesPath,
      workspaceDir: childB.childWorkspaceDir,
    });

    const events = await readEvents(root);
    const spawned = events.filter((e) => e.event === "AGENT:SUBAGENT_SPAWNED");
    expect(spawned).toHaveLength(2);
    expect(spawned.map((e) => e.child)).toContain("sub-work-a");
    expect(spawned.map((e) => e.child)).toContain("sub-work-b");

    const aLink = await lstat(path.join(childA.childWorkspaceDir, ".agent-events.jsonl"));
    expect(aLink.isSymbolicLink()).toBe(true);
    const bLink = await lstat(path.join(childB.childWorkspaceDir, ".agent-events.jsonl"));
    expect(bLink.isSymbolicLink()).toBe(true);

    // Events written via child symlinks land in the root log (SUBAGENT_SPAWNED came via parent,
    // but verifier runs wrote events via child workspaces → same file)
    const verifierEvents = events.filter((e) => e.event === "AGENT:VERIFIER_RUN");
    expect(verifierEvents).toHaveLength(2);
  });

  it("main → sub → sub-sub (depth 2) — COMPRESSION_EVENTs from all depths reach root log", async () => {
    const root = await tempDir();

    const sub = await spawnChildDirectives({
      parentWorkspaceDir: root,
      childId: "sub-worker",
      directivesContent: subDirectives("sub:worker:0001", "work.txt"),
      parentAgent: "main",
    });

    const subsub = await spawnChildDirectives({
      parentWorkspaceDir: sub.childWorkspaceDir,
      childId: "sub-inner",
      directivesContent: subDirectives("sub:inner:0002", "inner.txt"),
      parentAgent: "sub:worker:0001",
    });

    // Sub-sub fires a compression event through its workspace's symlink chain
    const { appendEvent } = await import("../src/events/log.js");
    await appendEvent(subsub.childWorkspaceDir, {
      event: "AGENT:COMPRESSION_EVENT",
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      agent: "sub:inner:0002",
      msgs_before: 120,
      msgs_after: 20,
      compacted_count: 100,
    });

    // Sub fires a compression event too
    await appendEvent(sub.childWorkspaceDir, {
      event: "AGENT:COMPRESSION_EVENT",
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      agent: "sub:worker:0001",
      msgs_before: 200,
      msgs_after: 30,
      compacted_count: 170,
    });

    // All events (SUBAGENT_SPAWNED × 2 + COMPRESSION_EVENT × 2) are in the root log
    const events = await readEvents(root);
    expect(events.filter((e) => e.event === "AGENT:SUBAGENT_SPAWNED")).toHaveLength(2);
    const compressionEvents = events.filter((e) => e.event === "AGENT:COMPRESSION_EVENT");
    expect(compressionEvents).toHaveLength(2);
    expect(compressionEvents.map((e) => e.agent)).toContain("sub:inner:0002");
    expect(compressionEvents.map((e) => e.agent)).toContain("sub:worker:0001");

    // The subsub workspace's symlink points into sub, which points to root
    const subsubLink = await lstat(path.join(subsub.childWorkspaceDir, ".agent-events.jsonl"));
    expect(subsubLink.isSymbolicLink()).toBe(true);
  });

  it("false TASK_COMPLETE claim — validateTaskComplete rejects missing pass, reVerifyChildClaim catches missing file", async () => {
    const root = await tempDir();

    const child = await spawnChildDirectives({
      parentWorkspaceDir: root,
      childId: "sub-liar",
      directivesContent: subDirectives("sub:liar:0001", "proof.txt"),
      parentAgent: "main",
    });

    // Child never creates proof.txt and never ran the verifier
    const fakeRunId = "vr-00000000-fake";
    const falseReport: TaskCompleteReport = {
      outputs: [{ kind: "file", path: "proof.txt", sha256: "a".repeat(64) }],
      dod_evidence: [{ criterion_index: 0, verifier_run_id: fakeRunId, result: "PASS" }],
      service_card_proposal: null,
    };

    // validateTaskComplete rejects: verifier_run_id not in pass registry
    await expect(
      validateTaskComplete({
        report: falseReport,
        agent: "sub:liar:0001",
        directivesPath: child.directivesPath,
        workspaceDir: child.childWorkspaceDir,
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof TaskCompleteValidationError &&
        e.reason === "missing_verifier_run_id_for_criterion_0",
    );

    // Even if we somehow recorded a pass, reVerifyChildClaim fails independently
    // because proof.txt does not exist
    const reVerify = await reVerifyChildClaim({
      childDirectivesPath: child.directivesPath,
      ctx: { workspaceDir: child.childWorkspaceDir, agent: "sub:liar:0001" },
    });
    expect(reVerify.allPass).toBe(false);
    expect(reVerify.failures[0]?.criterionIndex).toBe(0);
    expect(reVerify.failures[0]?.detail).toContain("file_exists");
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-p4-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function readEvents(
  dir: string,
): Promise<Array<{ event: string } & Record<string, unknown>>> {
  return (await readFile(path.join(dir, ".agent-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
}

async function sha256OfFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function subDirectives(agentId: string, outputFile: string): string {
  return `# DIRECTIVES (immutable for this agent's lifetime)
schema_version: 1
agent: ${agentId}
parent: main
workspace: /workspace/${agentId}
spawned: 2026-04-27T00:00:00Z
journal: ./JOURNAL.md

## GOAL
Produce ${outputFile}.

## INPUT CONTRACT
# (empty)

## OUTPUT CONTRACT
- kind: file
  path: ${outputFile}
  exports: []
  interface: "${agentId} output"

## DEFINITION OF DONE
- type: file_exists
  path: ${outputFile}

## CONSTRAINTS
# (none)

## TURN BUDGET
max_turns: 20
warning_at: 15
escalate_at: 18

## INITIAL DECOMPOSITION
- step-1: Produce ${outputFile}
- step-2: Self-verify and report TASK_COMPLETE

## PROTOCOL
You are an OpenClaw agent under the Persistent Directive System.
`;
}
