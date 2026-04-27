import crypto from "node:crypto";
import path from "node:path";
import {
  appendInventoryEntry,
  readInventory,
  writeServiceCard,
  type ServiceCardInput,
} from "../inventory/registry.js";
import { appendEvent } from "../events/log.js";
import { fileExists } from "../fs/atomic.js";
import { runAllDoD, type RunAllDoDResult } from "../verify/runner.js";
import {
  appendSealedOutputRegistry,
  markPlanStageSealed,
  readPlan,
} from "./plan.js";
import { readStage, sealStageFile } from "./stage.js";

export type SealStageContext = {
  workspaceDir: string;
  agent?: string;
  session?: string;
  now?: () => Date;
};

export type SealStageOptions = {
  planPath: string;
  stagePath: string;
  inventoryPath?: string;
  serviceCards?: ServiceCardInput[];
  ctx: SealStageContext;
};

export type SealStageResult = {
  stageId: string;
  verifierRun: RunAllDoDResult;
  serviceCards: ServiceCardInput[];
  outputs: string[];
};

export class StageSealRejectedError extends Error {
  readonly verifierRun?: RunAllDoDResult;

  constructor(message: string, verifierRun?: RunAllDoDResult) {
    super(message);
    this.name = "StageSealRejectedError";
    this.verifierRun = verifierRun;
  }
}

export async function sealStage(
  options: SealStageOptions,
): Promise<SealStageResult> {
  const { planPath, stagePath, ctx } = options;
  const workspaceDir = path.resolve(ctx.workspaceDir);
  const inventoryPath = options.inventoryPath ?? path.join(workspaceDir, "INVENTORY.md");
  const stage = await readStage(stagePath);
  if (stage.status !== "ACTIVE") {
    throw new StageSealRejectedError(
      `cannot seal ${stagePath}: expected ACTIVE, found ${stage.status}`,
    );
  }
  const stageId = path.basename(stagePath, path.extname(stagePath));
  const plan = await readPlan(planPath);
  const planStage = plan.stages.find((item) => item.id === stageId);
  if (!planStage) throw new StageSealRejectedError(`PLAN.md does not contain ${stageId}`);
  if (planStage.status !== "ACTIVE") {
    throw new StageSealRejectedError(
      `cannot seal ${stageId}: PLAN status is ${planStage.status}`,
    );
  }

  await preflightServiceCards(inventoryPath, options.serviceCards ?? []);
  await verifyOutputContract(workspaceDir, stage.outputContract, options.serviceCards ?? []);

  const verifierRun = await runAllDoD(stage.definitionOfDone, { workspaceDir });
  if (!verifierRun.allPass) {
    throw new StageSealRejectedError(
      `stage DoD failed for ${stageId}`,
      verifierRun,
    );
  }

  const sealedAt = isoNow(ctx);
  const serviceCards = options.serviceCards ?? inferServiceCards(stageId, stage, sealedAt, ctx);
  const outputs = stage.outputContract.map((item) => item.path);
  const summary = buildSealedSummary({
    outputs,
    serviceCards,
    verifierRun,
    sealedAt,
  });

  for (const card of serviceCards) {
    await writeServiceCard(workspaceDir, { ...card, sealed: sealedAt }, ctx);
  }
  for (const card of serviceCards) {
    await appendInventoryEntry(
      inventoryPath,
      {
        name: card.name,
        stage: card.stage,
        path: card.path,
        summary: card.summary,
      },
      ctx,
    );
  }

  await sealStageFile(stagePath, summary, { ...ctx, now: () => new Date(sealedAt) });
  const outSummary = outputs.join(", ") || serviceCards.map((card) => card.path).join(", ");
  await markPlanStageSealed(planPath, stageId, sealedAt, outSummary, ctx);
  for (const card of serviceCards) {
    await appendSealedOutputRegistry(
      planPath,
      { stage: stageId, summary: card.summary, inventoryPath: card.path },
      ctx,
    );
  }

  await appendEvent(workspaceDir, {
    event: "AGENT:STAGE_SEALED",
    event_id: crypto.randomUUID(),
    ts: sealedAt,
    agent: ctx.agent ?? "main",
    session: ctx.session,
    stage: stageId,
    outputs,
    registry: serviceCards.map((card) => card.path),
  });

  return { stageId, verifierRun, serviceCards, outputs };
}

async function preflightServiceCards(
  inventoryPath: string,
  cards: ServiceCardInput[],
): Promise<void> {
  if (await fileExists(inventoryPath)) {
    const inventory = await readInventory(inventoryPath);
    for (const card of cards) {
      const duplicate = inventory.entries.find(
        (entry) => entry.name === card.name || entry.path === card.path,
      );
      if (duplicate) {
        throw new StageSealRejectedError(
          `inventory already has ${duplicate.name} at ${duplicate.path}`,
        );
      }
    }
  }
  for (const card of cards) {
    if (await fileExists(path.resolve(path.dirname(inventoryPath), card.path))) {
      throw new StageSealRejectedError(`service card already exists at ${card.path}`);
    }
  }
}

async function verifyOutputContract(
  workspaceDir: string,
  outputs: Array<{ kind: string; path: string }>,
  cards: ServiceCardInput[],
): Promise<void> {
  const cardPaths = new Set(cards.map((card) => card.path));
  for (const output of outputs) {
    if (output.kind === "service") {
      if (!cardPaths.has(output.path)) {
        throw new StageSealRejectedError(
          `missing service card proposal for ${output.path}`,
        );
      }
      continue;
    }
    if (!(await fileExists(path.resolve(workspaceDir, output.path)))) {
      throw new StageSealRejectedError(
        `output contract path missing: ${output.path}`,
      );
    }
  }
}

function inferServiceCards(
  stageId: string,
  stage: Awaited<ReturnType<typeof readStage>>,
  sealedAt: string,
  ctx: SealStageContext,
): ServiceCardInput[] {
  return stage.outputContract
    .filter((output) => output.kind === "service")
    .map((output) => ({
      name: path.basename(output.path, path.extname(output.path)),
      stage: stageId,
      path: output.path,
      summary: output.interface ?? output.path,
      sealed: sealedAt,
      ownerAgent: ctx.agent ?? "main",
      interfaceMarkdown: output.interface,
    }));
}

function buildSealedSummary(input: {
  outputs: string[];
  serviceCards: ServiceCardInput[];
  verifierRun: RunAllDoDResult;
  sealedAt: string;
}): string {
  const lines = [
    "produced:",
    ...input.outputs.map((output) => `  - ${output}`),
    `registry_entry: ${input.serviceCards.map((card) => card.path).join(", ") || "none"}`,
    `sealed: ${input.sealedAt}`,
    `dod_status: ${input.verifierRun.allPass ? "all_pass" : "failed"}`,
    "notes: |",
    "  Stage sealed by verifier-gated orchestration.",
  ];
  return lines.join("\n");
}

function isoNow(ctx?: { now?: () => Date }): string {
  return (ctx?.now?.() ?? new Date()).toISOString();
}
