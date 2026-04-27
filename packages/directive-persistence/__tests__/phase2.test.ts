import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLiveStateInjection } from "../src/directives/inject.js";
import { parseDirectives } from "../src/directives/parse.js";
import {
  JournalWriteRejectedError,
  markStepBlocked,
  markStepDone,
  readJournal,
  recordVerifierRunInJournal,
} from "../src/directives/journal.js";
import type { Verifier } from "../src/directives/schema.js";
import {
  clearVerifierFailureCountersForTests,
  runDoDForStep,
  runVerifier,
} from "../src/verify/runner.js";
import { clearVerifierRegistryForTests } from "../src/verify/pass-registry.js";

const tempRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  clearVerifierRegistryForTests();
  clearVerifierFailureCountersForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Phase 2 verifiers", () => {
  it("checks file presence, absence, grep, size, shell commands, tests, and JSON schema", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "artifact.txt"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(dir, "data.json"), JSON.stringify({ ok: true, count: 2 }), "utf8");

    await expectPass({ type: "file_exists", path: "artifact.txt" }, dir);
    await expectPass({ type: "file_absent", path: "missing.txt" }, dir);
    await expectPass({ type: "grep_present", path: "artifact.txt", pattern: "export\\s+const" }, dir);
    await expectPass({ type: "grep_absent", path: "artifact.txt", pattern: "TODO|FIXME" }, dir);
    await expectPass({ type: "fs_size_under", path: "artifact.txt", max_bytes: 100 }, dir);
    await expectPass({ type: "shell_exit_zero", cmd: "node -e \"process.exit(0)\"" }, dir);
    await expectPass({ type: "shell_exit_nonzero", cmd: "node -e \"process.exit(7)\"" }, dir);
    await expectPass({ type: "test_passes", cmd: "node -e \"process.exit(0)\"" }, dir);
    await expectPass(
      {
        type: "json_schema_match",
        path: "data.json",
        schema: {
          type: "object",
          required: ["ok", "count"],
          properties: { ok: { const: true }, count: { type: "number" } },
        },
      },
      dir,
    );

    const grepFail = await runVerifier(
      { type: "grep_absent", path: "artifact.txt", pattern: "export" },
      { workspaceDir: dir },
    );
    expect(grepFail).toMatchObject({ pass: false });
  });

  it("checks HTTP status and expected JSON", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/ok" ? 201 : 404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ token: "ey.test", ok: request.url === "/ok" }));
    });
    servers.push(server);
    const port = await listen(server);

    await expectPass(
      {
        type: "http_status",
        url: `http://127.0.0.1:${port}/ok`,
        status: 201,
        expect_json: { token: { $regex: "^ey" }, ok: true },
      },
      await tempDir(),
    );
  });

  it("checks composite verifiers and llm_judge through the supplied judge provider", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "rubric.md"), "Score quality from 1 to 5.", "utf8");

    await expectPass(
      {
        type: "all_of",
        checks: [
          { type: "shell_exit_zero", cmd: "node -e \"process.exit(0)\"" },
          { type: "any_of", checks: [{ type: "file_absent", path: "nope" }] },
        ],
      },
      dir,
    );

    const result = await runVerifier(
      {
        type: "llm_judge",
        rubric_path: "rubric.md",
        inputs: [{ artifact: "report.md" }],
        min_score: 4,
      },
      {
        workspaceDir: dir,
        llmJudge: () => ({ score: 4.5, rationale: "meets rubric" }),
      },
    );

    expect(result).toMatchObject({ pass: true });
  });
});

describe("Phase 2 JOURNAL write protocol", () => {
  it("refuses DONE without the latest all-pass verifier run and emits completion events", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "JOURNAL.md");
    await writeFile(journalPath, sampleJournal("step-1"), "utf8");
    const ctx = { workspaceDir: dir, agent: "agent-1", session: "session-1" };

    await expect(markStepDone(journalPath, "step-1", ctx)).rejects.toBeInstanceOf(
      JournalWriteRejectedError,
    );

    const failingRun = await runDoDForStep(
      "step-1",
      [{ type: "shell_exit_zero", cmd: "node -e \"process.exit(1)\"" }],
      ctx,
    );
    await recordVerifierRunInJournal(journalPath, "step-1", failingRun, ctx);
    await expect(markStepDone(journalPath, "step-1", ctx)).rejects.toThrow(
      /latest verifier run .* failed/u,
    );

    const passingDoD: Verifier[] = [
      { type: "shell_exit_zero", cmd: "node -e \"process.exit(0)\"" },
    ];
    const passingRun = await runDoDForStep("step-1", passingDoD, ctx);
    await recordVerifierRunInJournal(journalPath, "step-1", passingRun, ctx);
    const journal = await markStepDone(journalPath, "step-1", ctx, {
      dod: passingDoD,
      verifiedOutputs: ["artifact.txt"],
    });

    expect(journal.taskStack[0]).toMatchObject({
      status: "DONE",
      verifierRunId: passingRun.verifierRunId,
      verifiedOutputs: ["artifact.txt"],
      blackBox: true,
    });
    expect(journal.taskStack[1]).toMatchObject({ status: "IN_PROGRESS" });

    const events = await readEvents(dir);
    expect(events.map((event) => event.event)).toContain("AGENT:VERIFIER_RUN");
    expect(events.map((event) => event.event)).toContain("AGENT:JOURNAL_WRITE");
    expect(events.map((event) => event.event)).toContain("AGENT:STEP_COMPLETE");
    expect(events.map((event) => event.event)).toContain("AGENT:BUDGET_WARNING");
  });

  it("keeps a failing step in progress, records working notes, and warns after 3 failures", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "JOURNAL.md");
    await writeFile(path.join(dir, "DIRECTIVES.md"), sampleDirectives(), "utf8");
    await writeFile(journalPath, sampleJournal("step-2"), "utf8");
    expect((await parseDirectives(path.join(dir, "DIRECTIVES.md"))).initialDecomposition).toHaveLength(3);
    const ctx = { workspaceDir: dir, agent: "agent-1", session: "session-1" };
    const step2DoD: Verifier[] = [
      {
        type: "shell_exit_zero",
        cmd: "node -e \"console.error('tsc error TS2345'); process.exit(1)\"",
      },
    ];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = await runDoDForStep("step-2", step2DoD, ctx);
      await recordVerifierRunInJournal(journalPath, "step-2", run, ctx);
      await expect(markStepDone(journalPath, "step-2", ctx)).rejects.toBeInstanceOf(
        JournalWriteRejectedError,
      );
    }

    const journal = await readJournal(journalPath);
    expect(journal.taskStack[1]).toMatchObject({ id: "step-2", status: "IN_PROGRESS" });
    expect(journal.workingNotes.join("\n")).toContain("tsc error TS2345");
    expect(buildLiveStateInjection(journal)).toContain("tsc error TS2345");

    await markStepBlocked(
      journalPath,
      "step-2",
      "implementation-hard: verifier failed 3 consecutive times",
      ctx,
    );

    const events = await readEvents(dir);
    expect(events.filter((event) => event.event === "AGENT:VERIFIER_RUN")).toHaveLength(3);
    expect(events.map((event) => event.event)).toContain("AGENT:STUCK_WARNING");
    expect(events.map((event) => event.event)).toContain("AGENT:BLOCKED");
  });
});

async function expectPass(verifier: Verifier, workspaceDir: string): Promise<void> {
  const result = await runVerifier(verifier, { workspaceDir });
  expect(result).toMatchObject({ pass: true });
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no port");
  return address.port;
}

async function readEvents(dir: string): Promise<Array<{ event: string } & Record<string, unknown>>> {
  return (await readFile(path.join(dir, ".agent-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
}

function sampleJournal(currentStepId: "step-1" | "step-2"): string {
  return `# JOURNAL
schema_version: 1
agent: agent-1
last_updated: 2026-04-16T03:58:04Z
turns_used: 1
max_turns: 10
warning_at: 2
escalate_at: 9
last_verifier_run: null

## TASK STACK
#### step-1: Prepare fixture
status: ${currentStepId === "step-1" ? "IN_PROGRESS" : "DONE"}
started: 2026-04-16T03:58:04Z
${currentStepId === "step-1" ? "" : "completed: 2026-04-16T03:59:04Z\nverifier_run_id: vr-seed\nblack_box: YES"}

#### step-2: Run scripted typecheck
status: ${currentStepId === "step-2" ? "IN_PROGRESS" : "PENDING"}
${currentStepId === "step-2" ? "started: 2026-04-16T04:00:00Z\nprogress: Awaiting verifier result.\nblocker: null" : ""}

#### step-3: Report completion
status: PENDING

## WORKING NOTES
# (empty)

## SUB-AGENTS
# (empty)

## COMPLETION REPORT
# Written once, at TASK_COMPLETE. Empty until then.
`;
}

function sampleDirectives(): string {
  return `# DIRECTIVES (immutable for this agent's lifetime)
schema_version: 1
agent: agent-1
parent: null
workspace: /tmp/infiniclaw-phase2
spawned: 2026-04-16T03:45:12Z
journal: ./JOURNAL.md

## GOAL
Complete a three-step verifier-gated task.

## INPUT CONTRACT
- path: fixture

## OUTPUT CONTRACT
- kind: artifact
  path: artifact.txt

## DEFINITION OF DONE
- type: shell_exit_zero
  cmd: "node -e \\"console.error('tsc error TS2345'); process.exit(1)\\""

## CONSTRAINTS
- Keep failed DoD evidence in WORKING NOTES.

## TURN BUDGET
max_turns: 10
warning_at: 2
escalate_at: 9

## INITIAL DECOMPOSITION
- step-1: Prepare fixture
- step-2: Run scripted typecheck
- step-3: Report completion

## PROTOCOL
Run verifiers before marking any step DONE.
`;
}
