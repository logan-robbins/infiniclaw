import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseDirectivesContent } from "../src/directives/parse.js";
import { parseJournalContent } from "../src/directives/journal.js";
import { readInventory, parseInventoryContent } from "../src/inventory/registry.js";
import { activateNextStage, parsePlanContent, readPlan } from "../src/plan/plan.js";
import { sealStage, StageSealRejectedError } from "../src/plan/seal.js";
import { activateStageFile, parseStageContent, readStage } from "../src/plan/stage.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("50-stage REST synthetic fixture generator", () => {
  it("generates parseable directive-system files", async () => {
    const dir = await tempDir();
    const script = path.resolve(
      process.cwd(),
      "../../bench/synthetic/fifty-stage-rest/generate-fixture.mjs",
    );

    await execFileAsync(process.execPath, [script, "--out", dir, "--stages", "3"]);

    const plan = parsePlanContent(await text(path.join(dir, "PLAN.md")));
    expect(plan.stages).toHaveLength(3);
    expect(plan.stages[1]).toMatchObject({
      id: "stage-02",
      depends: ["stage-01"],
    });

    const directives = parseDirectivesContent(await text(path.join(dir, "DIRECTIVES.md")));
    expect(directives.agent).toBe("main");
    expect(directives.definitionOfDone).toHaveLength(3);

    const journal = parseJournalContent(await text(path.join(dir, "JOURNAL.md")));
    expect(journal.taskStack[0]).toMatchObject({
      id: "step-1",
      status: "IN_PROGRESS",
    });

    const inventory = parseInventoryContent(await text(path.join(dir, "INVENTORY.md")));
    expect(inventory.entries).toHaveLength(0);

    for (const stageId of ["stage-01", "stage-02", "stage-03"]) {
      const stage = parseStageContent(
        await text(path.join(dir, "project-plan", `${stageId}.md`)),
      );
      expect(stage.outputContract.some((entry) => entry.kind === "file")).toBe(true);
      expect(stage.outputContract.some((entry) => entry.kind === "service")).toBe(true);
      expect(stage.definitionOfDone).toHaveLength(4);
    }
  });

  it("seals a short generated plan end to end without an external model", async () => {
    const dir = await tempDir();
    await generateFixture(dir, 3);

    const ctx = {
      workspaceDir: dir,
      agent: "main",
      session: "synthetic-e2e",
      now: () => new Date("2026-04-27T20:10:00.000Z"),
    };

    for (const expectedStage of ["stage-01", "stage-02", "stage-03"]) {
      const activated = await activateNextStage(path.join(dir, "PLAN.md"), ctx);
      expect(activated?.id).toBe(expectedStage);

      const stagePath = path.join(dir, "project-plan", `${expectedStage}.md`);
      await activateStageFile(stagePath, ctx);
      await writeSyntheticOutput(dir, expectedStage);

      const result = await sealStage({
        planPath: path.join(dir, "PLAN.md"),
        stagePath,
        inventoryPath: path.join(dir, "INVENTORY.md"),
        serviceCards: [serviceCard(expectedStage)],
        ctx,
      });

      expect(result.verifierRun.allPass).toBe(true);
      expect((await readStage(stagePath)).status).toBe("SEALED");
    }

    const plan = await readPlan(path.join(dir, "PLAN.md"));
    expect(plan.stages.map((stage) => stage.status)).toEqual([
      "SEALED",
      "SEALED",
      "SEALED",
    ]);
    expect((await readInventory(path.join(dir, "INVENTORY.md"))).entries).toHaveLength(3);

    const events = await readEvents(dir);
    expect(events.filter((event) => event.event === "AGENT:STAGE_SEALED")).toHaveLength(3);
  });

  it("rejects a planted defect before repairing and sealing", async () => {
    const dir = await tempDir();
    await generateFixture(dir, 2);
    const ctx = {
      workspaceDir: dir,
      agent: "main",
      session: "synthetic-defect",
      now: () => new Date("2026-04-27T20:20:00.000Z"),
    };

    await activateAndSealSyntheticStage(dir, "stage-01", ctx);

    expect((await activateNextStage(path.join(dir, "PLAN.md"), ctx))?.id).toBe("stage-02");
    const stagePath = path.join(dir, "project-plan", "stage-02.md");
    await activateStageFile(stagePath, ctx);
    await writeSyntheticOutput(dir, "stage-02", true);

    await expect(
      sealStage({
        planPath: path.join(dir, "PLAN.md"),
        stagePath,
        inventoryPath: path.join(dir, "INVENTORY.md"),
        serviceCards: [serviceCard("stage-02")],
        ctx,
      }),
    ).rejects.toBeInstanceOf(StageSealRejectedError);

    await writeSyntheticOutput(dir, "stage-02");
    const repaired = await sealStage({
      planPath: path.join(dir, "PLAN.md"),
      stagePath,
      inventoryPath: path.join(dir, "INVENTORY.md"),
      serviceCards: [serviceCard("stage-02")],
      ctx,
    });

    expect(repaired.verifierRun.allPass).toBe(true);
    expect((await readInventory(path.join(dir, "INVENTORY.md"))).entries).toHaveLength(2);
  });
});

async function generateFixture(dir: string, stages: number): Promise<void> {
  const script = path.resolve(
    process.cwd(),
    "../../bench/synthetic/fifty-stage-rest/generate-fixture.mjs",
  );
  await execFileAsync(process.execPath, [script, "--out", dir, "--stages", String(stages)]);
}

async function activateAndSealSyntheticStage(
  dir: string,
  stageId: string,
  ctx: {
    workspaceDir: string;
    agent: string;
    session: string;
    now: () => Date;
  },
): Promise<void> {
  expect((await activateNextStage(path.join(dir, "PLAN.md"), ctx))?.id).toBe(stageId);
  const stagePath = path.join(dir, "project-plan", `${stageId}.md`);
  await activateStageFile(stagePath, ctx);
  await writeSyntheticOutput(dir, stageId);
  await sealStage({
    planPath: path.join(dir, "PLAN.md"),
    stagePath,
    inventoryPath: path.join(dir, "INVENTORY.md"),
    serviceCards: [serviceCard(stageId)],
    ctx,
  });
}

async function writeSyntheticOutput(
  dir: string,
  stageId: string,
  defective = false,
): Promise<void> {
  const ordinal = Number.parseInt(stageId.split("-")[1] ?? "0", 10);
  const functionName = `stage${String(ordinal).padStart(2, "0")}`;
  const value = defective ? `${stageId}-wrong` : stageId;
  await writeFile(
    path.join(dir, "src", `${stageId}.mjs`),
    `export function ${functionName}() {\n  return "${value}";\n}\n`,
    "utf8",
  );
}

function serviceCard(stageId: string) {
  return {
    name: stageId,
    stage: stageId,
    path: `inventory/${stageId}.md`,
    summary: `${stageId} synthetic smoke service`,
    interfaceMarkdown: `Sealed synthetic output for ${stageId}.`,
  };
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-synthetic-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function text(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

async function readEvents(dir: string): Promise<Array<{ event: string }>> {
  return (await readFile(path.join(dir, ".agent-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string });
}
