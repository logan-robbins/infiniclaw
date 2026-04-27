import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  afterTurn,
  beforePromptBuild,
  type PluginHookAgentContext,
} from "../src/index.js";
import {
  clearDoneRevertStateForTests,
  drainNudges,
} from "../src/supervision/done-revert.js";
import { detectStuck } from "../src/supervision/stuck-detector.js";
import {
  parseJournalContent,
  readJournal,
  serializeJournal,
  writeJournalAtomic,
} from "../src/directives/journal.js";
import { clearVerifierRegistryForTests } from "../src/verify/pass-registry.js";
import {
  clearVerifierFailureCountersForTests,
  runDoDForStep,
} from "../src/verify/runner.js";
import { writeDirectivesInWorkspace } from "../src/spawn/write-directives.js";

// Verifier library smoke imports
import { buildDoD as sweBenchDoD } from "../src/verify/libraries/swe-bench.js";
import { buildDoD as mleBenchDoD } from "../src/verify/libraries/mle-bench.js";
import { buildDoD as hcastSweDoD } from "../src/verify/libraries/hcast-swe.js";
import { buildDoD as hcastGeneralDoD } from "../src/verify/libraries/hcast-general.js";
import { buildDoD as researchDoD } from "../src/verify/libraries/research-writeup.js";
import { buildDoD as refactorDoD } from "../src/verify/libraries/refactor.js";

const tempRoots: string[] = [];

afterEach(async () => {
  clearDoneRevertStateForTests();
  clearVerifierRegistryForTests();
  clearVerifierFailureCountersForTests();
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Phase 5 after_turn DONE-revert validator", () => {
  it("reverts an echo-DONE bypass and queues a nudge for the next turn", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "JOURNAL.md"), journalWithStep("step-1", "IN_PROGRESS"), "utf8");
    await writeDirectivesInWorkspace(dir, sampleDirectives("agent-a", "proof.txt"));

    const ctx = hookCtx("agent-a", dir);

    // Start of turn: capture snapshot
    await beforePromptBuild(null, ctx);

    // Agent cheats: writes DONE without running verifier
    const journal = await readJournal(path.join(dir, "JOURNAL.md"));
    const step = journal.taskStack.find((s) => s.id === "step-1")!;
    step.status = "DONE";
    step.completed = new Date().toISOString();
    await writeJournalAtomic(path.join(dir, "JOURNAL.md"), serializeJournal(journal));

    // End of turn: validator fires
    await afterTurn(null, ctx);

    // JOURNAL must be reverted
    const after = await readJournal(path.join(dir, "JOURNAL.md"));
    expect(after.taskStack.find((s) => s.id === "step-1")?.status).toBe("IN_PROGRESS");

    // Event emitted
    const events = await readEvents(dir);
    expect(events.some((e) => e.event === "AGENT:JOURNAL_DONE_REVERTED")).toBe(true);
    const revert = events.find((e) => e.event === "AGENT:JOURNAL_DONE_REVERTED")!;
    expect(revert.reason).toBe("no-verifier-run");

    // Nudge queued for next turn
    const nudges = drainNudges(ctx.sessionKey);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("step-1");
    expect(nudges[0]).toContain("verifier.run");
  });

  it("allows a legitimate DONE that has a fresh same-turn verifier pass", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "proof.txt"), "result\n", "utf8");
    await writeFile(path.join(dir, "JOURNAL.md"), journalWithStep("step-1", "IN_PROGRESS"), "utf8");
    await writeDirectivesInWorkspace(dir, sampleDirectives("agent-b", "proof.txt"));

    const ctx = hookCtx("agent-b", dir);

    // Start of turn 1
    await beforePromptBuild(null, ctx);

    // Agent runs verifier legitimately (turnNo = 1 = the current turn)
    const run = await runDoDForStep(
      "step-1",
      [{ type: "file_exists", path: "proof.txt" }],
      { workspaceDir: dir, agent: "agent-b", turnNo: 1 },
    );
    expect(run.allPass).toBe(true);

    // Agent writes DONE
    const journal = await readJournal(path.join(dir, "JOURNAL.md"));
    const step = journal.taskStack.find((s) => s.id === "step-1")!;
    step.status = "DONE";
    step.completed = new Date().toISOString();
    step.verifierRunId = run.verifierRunId;
    await writeJournalAtomic(path.join(dir, "JOURNAL.md"), serializeJournal(journal));

    // End of turn: validator should leave DONE intact
    await afterTurn(null, ctx);

    const after = await readJournal(path.join(dir, "JOURNAL.md"));
    expect(after.taskStack.find((s) => s.id === "step-1")?.status).toBe("DONE");

    const events = await readEvents(dir);
    expect(events.some((e) => e.event === "AGENT:JOURNAL_DONE_REVERTED")).toBe(false);
  });

  it("reverts a DONE that relies on a stale verifier pass from a previous turn", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "proof.txt"), "result\n", "utf8");
    await writeFile(path.join(dir, "JOURNAL.md"), journalWithStep("step-1", "IN_PROGRESS"), "utf8");
    await writeDirectivesInWorkspace(dir, sampleDirectives("agent-c", "proof.txt"));

    const ctx = hookCtx("agent-c", dir);

    // Verifier ran on turn 0 (previous turn) — stale
    await runDoDForStep(
      "step-1",
      [{ type: "file_exists", path: "proof.txt" }],
      { workspaceDir: dir, agent: "agent-c", turnNo: 0 },
    );

    // Start of turn 1 (increments counter to 1)
    await beforePromptBuild(null, ctx);

    // Agent writes DONE relying on the stale turn-0 pass
    const journal = await readJournal(path.join(dir, "JOURNAL.md"));
    journal.taskStack.find((s) => s.id === "step-1")!.status = "DONE";
    await writeJournalAtomic(path.join(dir, "JOURNAL.md"), serializeJournal(journal));

    await afterTurn(null, ctx);

    const after = await readJournal(path.join(dir, "JOURNAL.md"));
    expect(after.taskStack.find((s) => s.id === "step-1")?.status).toBe("IN_PROGRESS");

    const events = await readEvents(dir);
    const revert = events.find((e) => e.event === "AGENT:JOURNAL_DONE_REVERTED");
    expect(revert?.reason).toBe("stale-verifier-run");
  });

  it("nudge text appears in the next turn's prependSystemContext", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "JOURNAL.md"), journalWithStep("step-1", "IN_PROGRESS"), "utf8");
    await writeDirectivesInWorkspace(dir, sampleDirectives("agent-d", "proof.txt"));

    const ctx = hookCtx("agent-d", dir);

    // Turn 1: bypass → revert → nudge queued
    await beforePromptBuild(null, ctx);
    const j1 = await readJournal(path.join(dir, "JOURNAL.md"));
    j1.taskStack.find((s) => s.id === "step-1")!.status = "DONE";
    await writeJournalAtomic(path.join(dir, "JOURNAL.md"), serializeJournal(j1));
    await afterTurn(null, ctx);

    // Turn 2: beforePromptBuild should include the nudge
    const result = await beforePromptBuild(null, ctx);
    expect(result.prependSystemContext).toContain("SYSTEM NOTICE");
    expect(result.prependSystemContext).toContain("step-1");

    // Nudge is consumed; third turn has no nudge
    const result3 = await beforePromptBuild(null, ctx);
    expect(result3.prependSystemContext).not.toContain("SYSTEM NOTICE");
  });
});

describe("Phase 5 stuck-detector", () => {
  it("detects compression stall, verifier thrash, and budget overshoot", () => {
    const events = [
      compressionAt("agent-x", "step-2"),
      compressionAt("agent-x", "step-2"),
      compressionAt("agent-x", "step-2"),
      verifierFail("agent-x", "step-2", "tsc error TS2345"),
      verifierFail("agent-x", "step-2", "tsc error TS2345"),
      verifierFail("agent-x", "step-2", "tsc error TS2345"),
      { event: "AGENT:BUDGET_EXCEEDED", agent: "agent-y", ts: "2026-04-27T00:00:00Z" },
    ];

    const warnings = detectStuck(events);
    const agents = warnings.map((w) => w.agent);
    expect(agents.filter((a) => a === "agent-x")).toHaveLength(2);
    expect(agents).toContain("agent-y");

    const compressionWarn = warnings.find(
      (w) => w.agent === "agent-x" && w.heuristic.includes("compression"),
    );
    expect(compressionWarn?.step).toBe("step-2");

    const thrashWarn = warnings.find(
      (w) => w.agent === "agent-x" && w.heuristic.includes("verifier"),
    );
    expect(thrashWarn?.step).toBe("step-2");
  });

  it("clears compression stall when a STEP_COMPLETE fires between compressions", () => {
    const events = [
      compressionAt("agent-z", "step-1"),
      compressionAt("agent-z", "step-1"),
      { event: "AGENT:STEP_COMPLETE", agent: "agent-z", step: "step-1", ts: "2026-04-27T00:00:00Z" },
      compressionAt("agent-z", "step-1"),
      compressionAt("agent-z", "step-1"),
    ];
    const warnings = detectStuck(events);
    expect(warnings.filter((w) => w.agent === "agent-z" && w.heuristic.includes("compression"))).toHaveLength(0);
  });
});

describe("Phase 5 verifier library templates", () => {
  it("swe-bench.buildDoD produces correct verifier array", () => {
    const dod = sweBenchDoD({
      patchFile: "fix.patch",
      testCmd: "pytest tests/test_fix.py",
      neighborTestCmd: "pytest tests/",
    });
    expect(dod).toHaveLength(4);
    expect(dod[0]).toMatchObject({ type: "file_exists", path: "fix.patch" });
    expect(dod[1]).toMatchObject({ type: "shell_exit_zero", cmd: expect.stringContaining("git apply") });
    expect(dod[2]).toMatchObject({ type: "shell_exit_zero", cmd: "pytest tests/test_fix.py" });
    expect(dod[3]).toMatchObject({ type: "shell_exit_zero", cmd: "pytest tests/" });
  });

  it("mle-bench.buildDoD produces correct verifier array", () => {
    const dod = mleBenchDoD({
      submissionFile: "submission.json",
      submissionSchema: { type: "object" },
      submissionCmd: "python submit.py",
      metricCmd: "python score.py",
      metricThreshold: 0.75,
    });
    expect(dod).toHaveLength(4);
    expect(dod[0]).toMatchObject({ type: "file_exists" });
    expect(dod[1]).toMatchObject({ type: "json_schema_match" });
    expect(dod[2]).toMatchObject({ type: "shell_exit_zero", cmd: "python submit.py" });
    expect(dod[3]).toMatchObject({ type: "shell_exit_zero" });
  });

  it("hcast-swe.buildDoD includes target files + test cmd", () => {
    const dod = hcastSweDoD({
      testCmd: "pytest",
      targetFiles: ["src/foo.py", "src/bar.py"],
      lintCmd: "ruff check src/",
    });
    expect(dod).toHaveLength(4); // 2 file_exists + lint + test
    expect(dod.filter((v) => v.type === "file_exists")).toHaveLength(2);
  });

  it("hcast-general.buildDoD produces file_exists + llm_judge", () => {
    const dod = hcastGeneralDoD({
      taskDescription: "Solve the travelling salesman problem for 10 cities.",
      expectedOutputPath: "output/solution.json",
      minScore: 8,
    });
    expect(dod).toHaveLength(2);
    expect(dod[0]).toMatchObject({ type: "file_exists" });
    expect(dod[1]).toMatchObject({ type: "llm_judge", min_score: 8 });
  });

  it("research-writeup.buildDoD produces file_exists + word-count + llm_judge", () => {
    const dod = researchDoD({
      reportPath: "report.md",
      topic: "quantum computing",
      minWords: 500,
    });
    expect(dod).toHaveLength(3);
    expect(dod[2]).toMatchObject({ type: "llm_judge" });
  });

  it("refactor.buildDoD produces file_exists + test + fuzz", () => {
    const dod = refactorDoD({
      testCmd: "npm test",
      fuzzCmd: "node fuzz.js",
      targetFiles: ["src/util.ts"],
    });
    expect(dod).toHaveLength(3);
    expect(dod[1]).toMatchObject({ type: "shell_exit_zero", cmd: "npm test" });
    expect(dod[2]).toMatchObject({ type: "shell_exit_zero", cmd: "node fuzz.js" });
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-p5-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function readEvents(
  dir: string,
): Promise<Array<{ event: string } & Record<string, unknown>>> {
  try {
    return (await readFile(path.join(dir, ".agent-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
  } catch {
    return [];
  }
}

function hookCtx(agentId: string, workspaceDir: string): PluginHookAgentContext {
  return {
    sessionId: `${agentId}-session`,
    agentId,
    sessionKey: `${agentId}-key`,
    workspaceDir,
  };
}

function journalWithStep(stepId: string, status: string): string {
  return `# JOURNAL
schema_version: 1
agent: ${hookCtx(stepId, "").agentId || "test-agent"}
last_updated: 2026-04-27T00:00:00Z
turns_used: 1
last_verifier_run: null

## TASK STACK
#### ${stepId}: Do the thing
status: ${status}
started: 2026-04-27T00:00:00Z

## WORKING NOTES
# (empty)

## SUB-AGENTS
# (empty)

## COMPLETION REPORT
# (empty)
`;
}

function sampleDirectives(agentId: string, outputFile: string): string {
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

## PROTOCOL
You are an OpenClaw agent under the Persistent Directive System.
`;
}

function compressionAt(agent: string, step: string) {
  return {
    event: "AGENT:COMPRESSION_EVENT",
    agent,
    step_at_time: step,
    ts: "2026-04-27T00:00:00Z",
    msgs_before: 100,
    msgs_after: 20,
    compacted_count: 80,
  };
}

function verifierFail(agent: string, step: string, detail: string) {
  return {
    event: "AGENT:VERIFIER_RUN",
    agent,
    step,
    all_pass: false,
    ts: "2026-04-27T00:00:00Z",
    failures: [{ type: "shell_exit_zero", detail }],
  };
}
