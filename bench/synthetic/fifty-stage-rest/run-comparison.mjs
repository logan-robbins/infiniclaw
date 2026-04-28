#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const args = parseArgs(process.argv.slice(2));
const stageCount = Number.parseInt(args.stages ?? "3", 10);
const defectStage = args.defectStage ?? "stage-02";
const rootDir = path.resolve(
  args.out ?? (await mkdtemp(path.join(os.tmpdir(), "infiniclaw-compare-"))),
);
const baselineDir = path.join(rootDir, "baseline");
const infiniClawDir = path.join(rootDir, "infiniclaw");

if (!Number.isInteger(stageCount) || stageCount <= 0) {
  throw new Error(`--stages must be a positive integer, got ${args.stages}`);
}

const { activateNextStage, readPlan } = await importDist("plan/plan.js");
const { activateStageFile, readStage } = await importDist("plan/stage.js");
const { sealStage } = await importDist("plan/seal.js");
const { readInventory } = await importDist("inventory/registry.js");
const { runAllDoD } = await importDist("verify/runner.js");

await generateFixture(baselineDir, stageCount);
await generateFixture(infiniClawDir, stageCount);

const baseline = await runBaseline(baselineDir, stageCount, defectStage);
const infiniClaw = await runInfiniClaw(infiniClawDir, stageCount, defectStage);

console.log(
  JSON.stringify(
    {
      ok: baseline.false_done > 0 && infiniClaw.rejected_seals > 0 && infiniClaw.sealed === stageCount,
      workspace: rootDir,
      defect_stage: defectStage,
      baseline,
      infiniclaw: infiniClaw,
    },
    null,
    2,
  ),
);

async function runBaseline(workspaceDir, stages, plantedDefectStage) {
  let verifiedPass = 0;
  for (let index = 1; index <= stages; index += 1) {
    const stageId = stageIdFor(index);
    await writeSyntheticOutput(workspaceDir, stageId, stageId === plantedDefectStage);
    const stage = await readStage(path.join(workspaceDir, "project-plan", `${stageId}.md`));
    const run = await runAllDoD(stage.definitionOfDone, { workspaceDir });
    if (run.allPass) verifiedPass += 1;
  }
  return {
    claimed_done: stages,
    verified_pass: verifiedPass,
    false_done: stages - verifiedPass,
  };
}

async function runInfiniClaw(workspaceDir, stages, plantedDefectStage) {
  const ctx = {
    workspaceDir,
    agent: "main",
    session: "synthetic-comparison",
  };
  let rejectedSeals = 0;

  for (let index = 1; index <= stages; index += 1) {
    const stageId = stageIdFor(index);
    const stagePath = path.join(workspaceDir, "project-plan", `${stageId}.md`);
    const activated = await activateNextStage(path.join(workspaceDir, "PLAN.md"), ctx);
    if (activated?.id !== stageId) {
      throw new Error(`expected ${stageId} to activate, got ${activated?.id ?? "none"}`);
    }
    await activateStageFile(stagePath, ctx);

    if (stageId === plantedDefectStage) {
      await writeSyntheticOutput(workspaceDir, stageId, true);
      try {
        await sealStage({
          planPath: path.join(workspaceDir, "PLAN.md"),
          stagePath,
          inventoryPath: path.join(workspaceDir, "INVENTORY.md"),
          serviceCards: [serviceCard(stageId)],
          ctx,
        });
        throw new Error(`planted defect unexpectedly sealed for ${stageId}`);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "StageSealRejectedError") {
          throw error;
        }
        rejectedSeals += 1;
      }
    }

    await writeSyntheticOutput(workspaceDir, stageId, false);
    await sealStage({
      planPath: path.join(workspaceDir, "PLAN.md"),
      stagePath,
      inventoryPath: path.join(workspaceDir, "INVENTORY.md"),
      serviceCards: [serviceCard(stageId)],
      ctx,
    });
  }

  const plan = await readPlan(path.join(workspaceDir, "PLAN.md"));
  const inventory = await readInventory(path.join(workspaceDir, "INVENTORY.md"));
  return {
    sealed: plan.stages.filter((stage) => stage.status === "SEALED").length,
    rejected_seals: rejectedSeals,
    inventory_entries: inventory.entries.length,
  };
}

async function generateFixture(outDir, stages) {
  await execFileAsync(process.execPath, [
    path.join(here, "generate-fixture.mjs"),
    "--out",
    outDir,
    "--stages",
    String(stages),
  ]);
}

async function importDist(relativePath) {
  const filePath = path.join(
    repoRoot,
    "packages/directive-persistence/dist",
    relativePath,
  );
  try {
    return await import(pathToFileURL(filePath).href);
  } catch (error) {
    throw new Error(
      `Unable to import ${filePath}. Build first with: cd packages/directive-persistence && ../../node_modules/.bin/tsc -p tsconfig.json\n${error}`,
    );
  }
}

async function writeSyntheticOutput(dir, stageId, defective) {
  const ordinal = Number.parseInt(stageId.split("-")[1] ?? "0", 10);
  const functionName = `stage${String(ordinal).padStart(2, "0")}`;
  const value = defective ? `${stageId}-wrong` : stageId;
  await writeFile(
    path.join(dir, "src", `${stageId}.mjs`),
    `export function ${functionName}() {\n  return "${value}";\n}\n`,
    "utf8",
  );
}

function serviceCard(stageId) {
  return {
    name: stageId,
    stage: stageId,
    path: `inventory/${stageId}.md`,
    summary: `${stageId} synthetic comparison service`,
    interfaceMarkdown: `Sealed synthetic output for ${stageId}.`,
  };
}

function stageIdFor(index) {
  return `stage-${String(index).padStart(2, "0")}`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "--stages" || arg === "--defect-stage") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      const key = arg === "--defect-stage" ? "defectStage" : arg.slice(2);
      parsed[key] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
