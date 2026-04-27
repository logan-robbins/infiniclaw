import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendInventoryEntry,
  ensureInventory,
  preSpawnReuseCheck,
  readInventory,
} from "../src/inventory/registry.js";
import {
  ReplanRejectedError,
  activateNextStage,
  applyReplanDraft,
  readPlan,
} from "../src/plan/plan.js";
import { sealStage, StageSealRejectedError } from "../src/plan/seal.js";
import {
  StageWriteRejectedError,
  activateStageFile,
  readStage,
  replacePendingStageFile,
} from "../src/plan/stage.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Phase 3 PLAN, stage, and INVENTORY layer", () => {
  it("advances a 3-stage plan through verifier-gated stage seals", async () => {
    const dir = await tempDir();
    const planPath = path.join(dir, "PLAN.md");
    const inventoryPath = path.join(dir, "INVENTORY.md");
    await mkdir(path.join(dir, "project-plan"), { recursive: true });
    await mkdir(path.join(dir, "artifacts"), { recursive: true });
    await ensureInventory(inventoryPath);
    await writeFile(planPath, samplePlan(), "utf8");
    for (const id of ["stage-01-alpha", "stage-02-beta", "stage-03-gamma"]) {
      await writeFile(
        path.join(dir, "project-plan", `${id}.md`),
        sampleStage(id),
        "utf8",
      );
    }
    const ctx = {
      workspaceDir: dir,
      agent: "main",
      session: "session-1",
      now: fixedClock(),
    };

    await expect(
      sealStage({
        planPath,
        stagePath: path.join(dir, "project-plan/stage-01-alpha.md"),
        inventoryPath,
        serviceCards: [serviceCard("stage-01-alpha")],
        ctx,
      }),
    ).rejects.toBeInstanceOf(StageSealRejectedError);

    for (const id of ["stage-01-alpha", "stage-02-beta", "stage-03-gamma"]) {
      const activated = await activateNextStage(planPath, ctx);
      expect(activated?.id).toBe(id);
      const stagePath = path.join(dir, "project-plan", `${id}.md`);
      await activateStageFile(stagePath, ctx);
      await writeFile(path.join(dir, "artifacts", `${id}.txt`), `${id}\n`, "utf8");

      const result = await sealStage({
        planPath,
        stagePath,
        inventoryPath,
        serviceCards: [serviceCard(id)],
        ctx,
      });

      expect(result.verifierRun.allPass).toBe(true);
      expect((await readStage(stagePath)).status).toBe("SEALED");
    }

    const plan = await readPlan(planPath);
    expect(plan.stages.map((stage) => stage.status)).toEqual([
      "SEALED",
      "SEALED",
      "SEALED",
    ]);
    expect(plan.sealedOutputsRegistry).toHaveLength(3);
    expect((await readInventory(inventoryPath)).entries.map((entry) => entry.name)).toEqual([
      "stage-01-alpha",
      "stage-02-beta",
      "stage-03-gamma",
    ]);
    expect(await activateNextStage(planPath, ctx)).toBeUndefined();

    const events = await readEvents(dir);
    expect(events.map((event) => event.event)).toContain("AGENT:STAGE_ACTIVATED");
    expect(events.filter((event) => event.event === "AGENT:STAGE_SEALED")).toHaveLength(3);
  });

  it("enforces REPLAN: PENDING can change, ACTIVE and SEALED are frozen", async () => {
    const dir = await tempDir();
    const planPath = path.join(dir, "PLAN.md");
    const stagePath = path.join(dir, "project-plan/stage-03-gamma.md");
    await mkdir(path.dirname(stagePath), { recursive: true });
    await writeFile(planPath, replannablePlan(), "utf8");
    await writeFile(stagePath, sampleStage("stage-03-gamma"), "utf8");
    const ctx = { workspaceDir: dir, agent: "main", now: fixedClock() };

    const changedPending = replannablePlan().replace(
      "3. stage-03-gamma | PENDING | depends: [stage-02]",
      [
        "3. stage-03-delta | PENDING | depends: [stage-02]",
        "4. stage-04-epsilon | PENDING | depends: [stage-03]",
      ].join("\n"),
    );
    const replanned = await applyReplanDraft(planPath, changedPending, ctx);
    expect(replanned.stages.map((stage) => stage.id)).toContain("stage-03-delta");

    await expect(
      applyReplanDraft(
        planPath,
        changedPending.replace(
          "2. stage-02-beta | ACTIVE | depends: [stage-01]",
          "2. stage-02-beta | ACTIVE | depends: [stage-99]",
        ),
        ctx,
      ),
    ).rejects.toBeInstanceOf(ReplanRejectedError);

    await expect(
      applyReplanDraft(
        planPath,
        changedPending.replace(
          "1. stage-01-alpha | SEALED | seal: 2026-04-16T03:30:00.000Z | out: artifacts/stage-01-alpha.txt",
          "1. stage-01-alpha | SEALED | seal: 2026-04-16T03:30:00.000Z | out: changed.txt",
        ),
        ctx,
      ),
    ).rejects.toBeInstanceOf(ReplanRejectedError);

    const pendingStage = await replacePendingStageFile(
      stagePath,
      sampleStage("stage-03-gamma").replace("turn_budget: 20", "turn_budget: 30"),
    );
    expect(pendingStage.turnBudget).toBe(30);

    await activateStageFile(stagePath, ctx);
    await expect(
      replacePendingStageFile(
        stagePath,
        sampleStage("stage-03-gamma").replace("turn_budget: 20", "turn_budget: 40"),
      ),
    ).rejects.toBeInstanceOf(StageWriteRejectedError);
  });

  it("redirects duplicate work through INVENTORY pre-spawn reuse lookup", async () => {
    const dir = await tempDir();
    const inventoryPath = path.join(dir, "INVENTORY.md");
    await ensureInventory(inventoryPath);
    await appendInventoryEntry(inventoryPath, {
      name: "auth",
      stage: "stage-03-auth",
      path: "inventory/auth.md",
      summary: "POST /auth/login and POST /auth/logout router",
    });

    const reuse = await preSpawnReuseCheck(
      inventoryPath,
      "implement auth login logout endpoints",
    );
    expect(reuse).toMatchObject({
      reuse: true,
      entry: { name: "auth", path: "inventory/auth.md" },
    });
    if (reuse.reuse) {
      expect(reuse.message).toContain("consume it as a black box");
    }

    await expect(
      appendInventoryEntry(inventoryPath, {
        name: "auth",
        stage: "stage-04-auth-copy",
        path: "inventory/auth-copy.md",
        summary: "duplicate auth service",
      }),
    ).rejects.toThrow(/already exists/u);
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function readEvents(dir: string): Promise<Array<{ event: string } & Record<string, unknown>>> {
  return (await readFile(path.join(dir, ".agent-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
}

function fixedClock(): () => Date {
  return () => new Date("2026-04-16T04:00:00.000Z");
}

function serviceCard(id: string) {
  return {
    name: id,
    stage: id,
    path: `inventory/${id}.md`,
    summary: `${id} sealed service`,
    interfaceMarkdown: `Interface for ${id}.`,
  };
}

function samplePlan(): string {
  return `# PLAN — Phase 3 Fixture
schema_version: 1
created: 2026-04-16T03:14:22.000Z
last_replanned: 2026-04-16T03:14:22.000Z
status: ACTIVE
owner: main
turn_budget_total: 200
cost_budget_usd: 5.00

## Goal
Seal three dependent stages.

## High-Level Definition of Done
- type: shell_exit_zero
  cmd: "node -e \\"process.exit(0)\\""

## Stages
1. stage-01-alpha | PENDING
2. stage-02-beta | PENDING | depends: [stage-01]
3. stage-03-gamma | PENDING | depends: [stage-02]

## Sealed Outputs Registry
# (empty)

## Global Constraints
- Every sealed output publishes to INVENTORY.md.

## Notes
Fixture plan.
`;
}

function replannablePlan(): string {
  return samplePlan()
    .replace("1. stage-01-alpha | PENDING", "1. stage-01-alpha | SEALED | seal: 2026-04-16T03:30:00.000Z | out: artifacts/stage-01-alpha.txt")
    .replace("2. stage-02-beta | PENDING | depends: [stage-01]", "2. stage-02-beta | ACTIVE | depends: [stage-01]");
}

function sampleStage(id: string): string {
  return `# Stage ${id}
schema_version: 1
status: PENDING
created: 2026-04-16T03:14:22.000Z
activated: null
sealed: null
turn_budget: 20

## Depends On
# (empty)

## Output Contract
- kind: file
  path: artifacts/${id}.txt
  exports: []
  interface: "${id} artifact"
- kind: service
  path: inventory/${id}.md
  interface: "${id} sealed service"

## Definition of Done
- type: file_exists
  path: artifacts/${id}.txt
- type: shell_exit_zero
  cmd: "node -e \\"process.exit(0)\\""

## Sub-Tasks
A:
  id: ${id}.A
  goal: Produce ${id}
  input_contract: []
  output_contract:
    - path: artifacts/${id}.txt
  can_start: immediately
  turn_budget: 10

## Context for Sub-Agents
- Use the fixture artifact path.

## Execution Log
# (empty)

## SEALED SUMMARY
# (empty)
`;
}
