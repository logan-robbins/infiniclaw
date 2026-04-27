import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  afterCompaction,
  beforeCompaction,
  beforePromptBuild,
  register,
  type PluginHookAgentContext,
} from "../src/index.js";
import {
  DirectivesAlreadyExistsError,
  buildExtraSystemPrompt,
  writeDirectives,
} from "../src/spawn/write-directives.js";
import {
  parseDirectivesContent,
  DirectivesParseError,
} from "../src/directives/parse.js";
import {
  parseJournalContent,
  readJournal,
  serializeJournal,
  writeJournalAtomic,
  writeParsedJournalAtomic,
} from "../src/directives/journal.js";
import { buildLiveStateInjection } from "../src/directives/inject.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Phase 1 foundation", () => {
  it("parses DIRECTIVES.md into typed fields and reports line/column failures", () => {
    const directives = parseDirectivesContent(sampleDirectives());

    expect(directives.agent).toBe("sub:auth-a:d7e9");
    expect(directives.parent).toBe("main");
    expect(directives.definitionOfDone).toHaveLength(4);
    expect(directives.definitionOfDone[1]?.type).toBe("shell_exit_zero");
    expect(directives.turnBudget).toEqual({
      maxTurns: 80,
      warningAt: 60,
      escalateAt: 75,
    });
    expect(directives.initialDecomposition[0]).toMatchObject({
      id: "step-1",
      text: "Read INPUT CONTRACT sources; confirm presence of services",
    });

    expect(() =>
      parseDirectivesContent(sampleDirectives().replace("schema_version: 1", "schema_version: nope")),
    ).toThrow(DirectivesParseError);

    try {
      parseDirectivesContent(sampleDirectives().replace("schema_version: 1", "schema_version: nope"));
    } catch (error) {
      expect(error).toBeInstanceOf(DirectivesParseError);
      expect((error as DirectivesParseError).line).toBe(2);
      expect((error as DirectivesParseError).column).toBeGreaterThan(1);
    }
  });

  it("parses and writes JOURNAL.md round-trips with atomic replacement", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "JOURNAL.md");
    const journal = parseJournalContent(sampleJournal());
    const serialized = serializeJournal(journal);

    await writeJournalAtomic(journalPath, serialized);
    const fromDisk = await readJournal(journalPath);

    expect(fromDisk.agent).toBe("sub:auth-a:d7e9");
    expect(fromDisk.taskStack[2]).toMatchObject({
      id: "step-3",
      status: "IN_PROGRESS",
      progress: "Wired Redis rate-limit; 401 path done; adding 429 path.",
      turnsInStep: 4,
    });

    fromDisk.turnsUsed = 13;
    await writeParsedJournalAtomic(journalPath, fromDisk);
    const rewritten = await readJournal(journalPath);
    expect(rewritten.turnsUsed).toBe(13);
    expect(rewritten.turnBudget?.maxTurns).toBe(80);
  });

  it("keeps the prior JOURNAL intact if a write dies after temp fsync", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "JOURNAL.md");
    await writeFile(journalPath, "prior", "utf8");

    await expect(
      writeJournalAtomic(journalPath, "replacement", {
        simulateCrashAfterTempWrite: true,
      }),
    ).rejects.toThrow("simulated crash");

    expect(await readFile(journalPath, "utf8")).toBe("prior");
  });

  it("refuses to overwrite DIRECTIVES.md and leaves the original intact", async () => {
    const dir = await tempDir();
    const directivesPath = path.join(dir, "DIRECTIVES.md");
    const first = sampleDirectives();
    const second = sampleDirectives().replace("sub:auth-a:d7e9", "sub:other");

    const result = await writeDirectives(directivesPath, first);
    expect(result.extraSystemPrompt).toBe(buildExtraSystemPrompt(first));
    await expect(writeDirectives(directivesPath, second)).rejects.toBeInstanceOf(
      DirectivesAlreadyExistsError,
    );

    expect(await readFile(directivesPath, "utf8")).toBe(first);
  });

  it("builds the byte-stable LIVE STATE block from JOURNAL fields", () => {
    const injection = buildLiveStateInjection(parseJournalContent(sampleJournal()));

    expect(injection).toContain("## LIVE STATE  [from JOURNAL.md, re-read every turn");
    expect(injection).toContain(
      "CURRENT STEP:   step-3 — Implement loginHandler (error paths: 401, 429)",
    );
    expect(injection).toContain("PROGRESS:       Wired Redis rate-limit");
    expect(injection).toContain("NEXT STEP:      step-4 — Implement logoutHandler");
    expect(injection).toContain("Before any new file, grep ../../INVENTORY.md");
  });

  it("registers hooks and keeps non-directive sessions zero-footprint", async () => {
    const registered: string[] = [];
    register({
      on(name) {
        registered.push(name);
      },
    });
    expect(registered).toEqual([
      "before_prompt_build",
      "before_compaction",
      "after_compaction",
      "after_turn",
    ]);

    const dir = await tempDir();
    const ctx = context(dir);

    expect(await beforePromptBuild({}, ctx)).toEqual({});
    await beforeCompaction({ messageCount: 10, tokenCount: 100 }, ctx);
    await afterCompaction(
      { messageCount: 5, compactedCount: 5, tokenCount: 60, sessionFile: "s.json" },
      ctx,
    );
    await expect(readFile(path.join(dir, ".agent-events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("injects live state and logs compaction events when JOURNAL exists", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "JOURNAL.md"), sampleJournal(), "utf8");
    const ctx = context(dir);

    const prompt = await beforePromptBuild({}, ctx);
    expect(prompt.prependSystemContext).toContain("CURRENT STEP:   step-3");

    await beforeCompaction({ messageCount: 10, tokenCount: 100 }, ctx);
    await afterCompaction(
      { messageCount: 5, compactedCount: 5, tokenCount: 60, sessionFile: "s.json" },
      ctx,
    );

    const lines = (await readFile(path.join(dir, ".agent-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; snapshot?: unknown });

    expect(lines.map((line) => line.event)).toEqual([
      "AGENT:PRE_COMPRESSION_SNAPSHOT",
      "AGENT:COMPRESSION_EVENT",
    ]);
    expect(JSON.stringify(lines[0]?.snapshot).length).toBeLessThanOrEqual(400);
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function context(workspaceDir: string): PluginHookAgentContext {
  return {
    sessionId: "session-1",
    agentId: "sub:auth-a:d7e9",
    sessionKey: "session-key",
    workspaceDir,
  };
}

function sampleDirectives(): string {
  return `# DIRECTIVES (immutable for this agent's lifetime)
schema_version: 1
agent: sub:auth-a:d7e9
parent: main
workspace: /workspace/sub-auth-a-d7e9
spawned: 2026-04-16T03:45:12Z
journal: ./JOURNAL.md

## GOAL
Implement POST /auth/login and POST /auth/logout in src/routes/auth.ts per the
auth stage output contract.

## INPUT CONTRACT
- service: inventory/db-schema.md
- service: inventory/redis-session.md

## OUTPUT CONTRACT
- kind: file
  path: src/routes/auth.ts
  exports: ["authRouter"]
  interface: "express.Router mounting POST /auth/login, POST /auth/logout"

## DEFINITION OF DONE
- type: file_exists
  path: src/routes/auth.ts
- type: shell_exit_zero
  cmd: "npx tsc --noEmit -p tsconfig.json"
- type: grep_present
  path: src/routes/auth.ts
  pattern: "export\\\\s+const\\\\s+authRouter"
- type: grep_absent
  path: src/routes/auth.ts
  pattern: "TODO|FIXME|console\\\\.log|password\\\\s*=\\\\s*[\\"']"

## CONSTRAINTS
- No hardcoded secrets.
- No new dependencies without parent approval (report BLOCKED).

## TURN BUDGET
max_turns: 80
warning_at: 60
escalate_at: 75

## INITIAL DECOMPOSITION
- step-1: Read INPUT CONTRACT sources; confirm presence of services
- step-2: Implement loginHandler (happy path)
- step-3: Implement loginHandler (error paths: 401, 429)
- step-4: Implement logoutHandler
- step-5: Self-run full DoD verifier; report TASK_COMPLETE

## PROTOCOL
You are an OpenClaw agent under the Persistent Directive System.
`;
}

function sampleJournal(): string {
  return `# JOURNAL
schema_version: 1
agent: sub:auth-a:d7e9
last_updated: 2026-04-16T03:58:04Z
turns_used: 12
max_turns: 80
warning_at: 60
escalate_at: 75
last_verifier_run: 2026-04-16T03:57:58Z

## TASK STACK
#### step-1: Read INPUT CONTRACT sources; confirm presence of services
status: DONE
completed: 2026-04-16T03:46:30Z
verifier_run_id: vr-0001
verified_outputs:
  - inventory/db-schema.md read, users section confirmed
black_box: YES

#### step-2: Implement loginHandler (happy path)
status: DONE
completed: 2026-04-16T03:52:11Z
verifier_run_id: vr-0004
verified_outputs:
  - src/routes/auth.ts exports authRouter
black_box: YES

#### step-3: Implement loginHandler (error paths: 401, 429)
status: IN_PROGRESS
started: 2026-04-16T03:52:11Z
progress: "Wired Redis rate-limit; 401 path done; adding 429 path."
blocker: null
turns_in_step: 4
last_verifier_failures: []

#### step-4: Implement logoutHandler
status: PENDING
depends_on:
  - step-3
expected_output: "src/routes/auth.ts:logoutHandler invalidates session in Redis"

## WORKING NOTES
- Redis session key pattern from inventory/redis-session.md: "sess:{jti}".
- Rate-limit key: "rl:login:{email}" with 5 req / 5 min window.

## SUB-AGENTS
# (empty for this leaf agent)

## COMPLETION REPORT
# Written once, at TASK_COMPLETE. Empty until then.
`;
}
