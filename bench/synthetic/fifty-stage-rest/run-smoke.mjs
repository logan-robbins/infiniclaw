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
const outDir = path.resolve(
  args.out ?? (await mkdtemp(path.join(os.tmpdir(), "infiniclaw-smoke-"))),
);

if (!Number.isInteger(stageCount) || stageCount <= 0) {
  throw new Error(`--stages must be a positive integer, got ${args.stages}`);
}

const {
  activateNextStage,
  readPlan,
} = await importDist("plan/plan.js");
const {
  activateStageFile,
  readStage,
} = await importDist("plan/stage.js");
const { sealStage } = await importDist("plan/seal.js");
const { readInventory } = await importDist("inventory/registry.js");

await execFileAsync(process.execPath, [
  path.join(here, "generate-fixture.mjs"),
  "--out",
  outDir,
  "--stages",
  String(stageCount),
]);

const ctx = {
  workspaceDir: outDir,
  agent: "main",
  session: "synthetic-smoke",
};

for (let index = 1; index <= stageCount; index += 1) {
  const stageId = `stage-${String(index).padStart(2, "0")}`;
  const activated = await activateNextStage(path.join(outDir, "PLAN.md"), ctx);
  if (activated?.id !== stageId) {
    throw new Error(`expected ${stageId} to activate, got ${activated?.id ?? "none"}`);
  }

  const stagePath = path.join(outDir, "project-plan", `${stageId}.md`);
  await activateStageFile(stagePath, ctx);
  await writeSyntheticOutput(outDir, stageId);

  const sealed = await sealStage({
    planPath: path.join(outDir, "PLAN.md"),
    stagePath,
    inventoryPath: path.join(outDir, "INVENTORY.md"),
    serviceCards: [serviceCard(stageId)],
    ctx,
  });
  if (!sealed.verifierRun.allPass) {
    throw new Error(`stage verifier failed for ${stageId}`);
  }
  if ((await readStage(stagePath)).status !== "SEALED") {
    throw new Error(`stage did not seal: ${stageId}`);
  }
}

const plan = await readPlan(path.join(outDir, "PLAN.md"));
const inventory = await readInventory(path.join(outDir, "INVENTORY.md"));
const sealedCount = plan.stages.filter((stage) => stage.status === "SEALED").length;

console.log(
  JSON.stringify(
    {
      ok: sealedCount === stageCount && inventory.entries.length === stageCount,
      workspace: outDir,
      stages: stageCount,
      sealed: sealedCount,
      inventory_entries: inventory.entries.length,
    },
    null,
    2,
  ),
);

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

async function writeSyntheticOutput(dir, stageId) {
  const ordinal = Number.parseInt(stageId.split("-")[1] ?? "0", 10);
  const functionName = `stage${String(ordinal).padStart(2, "0")}`;
  await writeFile(
    path.join(dir, "src", `${stageId}.mjs`),
    `export function ${functionName}() {\n  return "${stageId}";\n}\n`,
    "utf8",
  );
}

function serviceCard(stageId) {
  return {
    name: stageId,
    stage: stageId,
    path: `inventory/${stageId}.md`,
    summary: `${stageId} synthetic smoke service`,
    interfaceMarkdown: `Sealed synthetic output for ${stageId}.`,
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "--stages") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
