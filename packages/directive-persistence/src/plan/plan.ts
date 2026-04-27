import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LineCounter, parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  planSchema,
  verifierSchema,
  type Plan,
  type PlanStage,
  type Verifier,
} from "../directives/schema.js";
import { appendEvent } from "../events/log.js";
import { fileExists, writeFileAtomic } from "../fs/atomic.js";

type MarkdownSection = {
  title: string;
  line: number;
  content: string;
  lines: string[];
};

type MetadataValue = {
  value: string;
  line: number;
  column: number;
};

export type PlanWriteContext = {
  workspaceDir?: string;
  agent?: string;
  session?: string;
  now?: () => Date;
};

export type SealedOutputRegistryEntry = {
  stage: string;
  summary: string;
  inventoryPath: string;
};

export class PlanParseError extends Error {
  readonly filePath?: string;
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number, filePath?: string) {
    super(`${message} (${filePath ?? "PLAN.md"}:${line}:${column})`);
    this.name = "PlanParseError";
    this.filePath = filePath;
    this.line = line;
    this.column = column;
  }
}

export class ReplanRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplanRejectedError";
  }
}

export async function readPlan(filePath: string): Promise<Plan> {
  const content = await readFile(filePath, "utf8");
  return parsePlanContent(content, filePath);
}

export function parsePlanContent(content: string, filePath?: string): Plan {
  const lines = content.split(/\r?\n/u);
  const title = parseTitle(lines);
  const metadata = parseMetadata(lines, filePath);
  const sections = parseSections(lines);
  const getSection = (name: string): MarkdownSection => {
    const section = sections.get(name);
    if (!section) {
      throw new PlanParseError(`missing required section ## ${name}`, 1, 1, filePath);
    }
    return section;
  };

  const parsed = {
    title,
    schemaVersion: parseIntegerField(metadata, "schema_version", filePath),
    created: readMetadata(metadata, "created", filePath).value,
    lastReplanned: readMetadata(metadata, "last_replanned", filePath).value,
    status: readMetadata(metadata, "status", filePath).value,
    owner: readMetadata(metadata, "owner", filePath).value,
    turnBudgetTotal: parseIntegerField(metadata, "turn_budget_total", filePath),
    costBudgetUsd: parseNumberField(metadata, "cost_budget_usd", filePath),
    goal: normalizeBlock(getSection("Goal").content),
    highLevelDefinitionOfDone: parseDefinitionOfDone(
      getSection("High-Level Definition of Done"),
      filePath,
    ),
    stages: parseStages(getSection("Stages"), filePath),
    sealedOutputsRegistry: parseBulletText(getSection("Sealed Outputs Registry")),
    globalConstraints: parseBulletText(getSection("Global Constraints")),
    notes: normalizeBlock(getSection("Notes").content),
    raw: content,
  };

  const result = planSchema.safeParse(parsed);
  if (!result.success) throw zodToPlanError(result.error, filePath);
  return result.data;
}

export async function writePlanAtomic(
  filePath: string,
  plan: Plan,
): Promise<void> {
  await writeFileAtomic(filePath, serializePlan(plan));
}

export async function bootstrapPlan(
  filePath: string,
  content: string,
  ctx: PlanWriteContext = {},
): Promise<Plan> {
  if (await fileExists(filePath)) {
    throw new ReplanRejectedError(`PLAN.md already exists at ${filePath}`);
  }
  const plan = parsePlanContent(content, filePath);
  await writeFileAtomic(filePath, serializePlan(plan));
  await appendPlanEvent(filePath, ctx, {
    event: "AGENT:PLAN_BOOTSTRAPPED",
    stages: plan.stages.length,
  });
  return plan;
}

export function serializePlan(plan: Plan): string {
  const lines = [
    plan.title,
    `schema_version: ${plan.schemaVersion}`,
    `created: ${plan.created}`,
    `last_replanned: ${plan.lastReplanned}`,
    `status: ${plan.status}`,
    `owner: ${plan.owner}`,
    `turn_budget_total: ${plan.turnBudgetTotal}`,
    `cost_budget_usd: ${plan.costBudgetUsd.toFixed(2)}`,
    "",
    "## Goal",
    plan.goal,
    "",
    "## High-Level Definition of Done",
    serializeYamlList(plan.highLevelDefinitionOfDone),
    "",
    "## Stages",
  ];
  for (const stage of plan.stages) lines.push(formatStageLine(stage));
  lines.push("", "## Sealed Outputs Registry");
  pushBullets(lines, plan.sealedOutputsRegistry);
  lines.push("", "## Global Constraints");
  pushBullets(lines, plan.globalConstraints);
  lines.push("", "## Notes");
  lines.push(plan.notes || "# (empty)");
  return `${lines.join("\n")}\n`;
}

export function getRunnableStages(plan: Plan): PlanStage[] {
  return plan.stages.filter(
    (stage) =>
      stage.status === "PENDING" &&
      stage.depends.every((dependency) => isDependencySealed(plan, dependency)),
  );
}

export function getActiveStage(plan: Plan): PlanStage | undefined {
  return plan.stages.find((stage) => stage.status === "ACTIVE");
}

export async function activateNextStage(
  planPath: string,
  ctx: PlanWriteContext = {},
): Promise<PlanStage | undefined> {
  const plan = await readPlan(planPath);
  const existingActive = getActiveStage(plan);
  if (existingActive) return existingActive;

  const next = getRunnableStages(plan)[0];
  if (!next) return undefined;
  next.status = "ACTIVE";
  await writePlanAtomic(planPath, plan);
  await appendPlanEvent(planPath, ctx, {
    event: "AGENT:STAGE_ACTIVATED",
    stage: next.id,
  });
  return next;
}

export async function markPlanStageSealed(
  planPath: string,
  stageId: string,
  sealedAt: string,
  out: string,
  ctx: PlanWriteContext = {},
): Promise<Plan> {
  const plan = await readPlan(planPath);
  const stage = findStage(plan, stageId);
  if (stage.status !== "ACTIVE") {
    throw new ReplanRejectedError(
      `cannot seal ${stageId}: expected ACTIVE, found ${stage.status}`,
    );
  }
  stage.status = "SEALED";
  stage.seal = sealedAt;
  stage.out = out;
  await writePlanAtomic(planPath, plan);
  await appendPlanEvent(planPath, ctx, {
    event: "AGENT:PLAN_STAGE_MARKED_SEALED",
    stage: stageId,
    out,
  });
  return plan;
}

export async function appendSealedOutputRegistry(
  planPath: string,
  entry: SealedOutputRegistryEntry,
  ctx: PlanWriteContext = {},
): Promise<Plan> {
  const plan = await readPlan(planPath);
  const line = `${entry.stage}: ${entry.summary} — see ${entry.inventoryPath}`;
  if (!plan.sealedOutputsRegistry.includes(line)) {
    plan.sealedOutputsRegistry.push(line);
  }
  await writePlanAtomic(planPath, plan);
  await appendPlanEvent(planPath, ctx, {
    event: "AGENT:PLAN_REGISTRY_UPDATED",
    stage: entry.stage,
    inventory_path: entry.inventoryPath,
  });
  return plan;
}

export async function applyReplanDraft(
  planPath: string,
  draftContent: string,
  ctx: PlanWriteContext = {},
): Promise<Plan> {
  const current = await readPlan(planPath);
  const draft = parsePlanContent(draftContent, `${planPath}.replan-draft`);

  for (const oldStage of current.stages) {
    if (oldStage.status !== "ACTIVE" && oldStage.status !== "SEALED") continue;
    const nextStage = draft.stages.find((stage) => stage.id === oldStage.id);
    if (!nextStage) {
      throw new ReplanRejectedError(
        `REPLAN rejected: ${oldStage.status} stage ${oldStage.id} cannot be removed`,
      );
    }
    if (!sameLockedStage(oldStage, nextStage)) {
      throw new ReplanRejectedError(
        `REPLAN rejected: ${oldStage.status} stage ${oldStage.id} is immutable`,
      );
    }
  }

  draft.lastReplanned = isoNow(ctx);
  await writePlanAtomic(planPath, draft);
  await appendPlanEvent(planPath, ctx, {
    event: "AGENT:REPLAN",
    affected_stages: changedPendingStages(current, draft),
  });
  return draft;
}

export function findStage(plan: Plan, stageId: string): PlanStage {
  const stage = plan.stages.find((item) => item.id === stageId);
  if (!stage) throw new ReplanRejectedError(`stage not found: ${stageId}`);
  return stage;
}

function parseStages(section: MarkdownSection, filePath?: string): PlanStage[] {
  const stages: PlanStage[] = [];
  for (let offset = 0; offset < section.lines.length; offset += 1) {
    const raw = (section.lines[offset] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    const match = /^(\d+)\.\s+([^|]+?)\s*\|\s*([A-Z]+)\s*(?:\|\s*(.*))?$/u.exec(raw);
    if (!match) {
      throw new PlanParseError(
        "stage entries must be 'N. stage-id | STATUS | ...'",
        section.line + offset + 1,
        1,
        filePath,
      );
    }
    const [, ordinalRaw, idRaw, statusRaw, tailRaw] = match;
    const stage: PlanStage = {
      ordinal: Number.parseInt(ordinalRaw ?? "0", 10),
      id: (idRaw ?? "").trim(),
      status: statusRaw as PlanStage["status"],
      depends: [],
    };
    for (const field of (tailRaw ?? "").split("|").map((item) => item.trim()).filter(Boolean)) {
      const separator = field.indexOf(":");
      if (separator === -1) continue;
      const key = field.slice(0, separator).trim();
      const value = field.slice(separator + 1).trim();
      if (key === "depends") stage.depends = parseBracketList(value);
      else if (key === "seal") stage.seal = value;
      else if (key === "out") stage.out = value;
    }
    stages.push(stage);
  }
  return stages;
}

function formatStageLine(stage: PlanStage): string {
  const fields = [`${stage.ordinal}. ${stage.id}`, stage.status];
  if (stage.seal) fields.push(`seal: ${stage.seal}`);
  if (stage.out) fields.push(`out: ${stage.out}`);
  if (stage.depends.length > 0) fields.push(`depends: [${stage.depends.join(", ")}]`);
  return fields.join(" | ");
}

function isDependencySealed(plan: Plan, dependency: string): boolean {
  return plan.stages.some(
    (stage) =>
      stage.status === "SEALED" &&
      (stage.id === dependency || stage.id.startsWith(`${dependency}-`)),
  );
}

function sameLockedStage(a: PlanStage, b: PlanStage): boolean {
  return (
    a.ordinal === b.ordinal &&
    a.id === b.id &&
    a.status === b.status &&
    listEqual(a.depends, b.depends) &&
    a.seal === b.seal &&
    a.out === b.out
  );
}

function changedPendingStages(current: Plan, draft: Plan): string[] {
  const changed = new Set<string>();
  for (const oldStage of current.stages.filter((stage) => stage.status === "PENDING")) {
    const nextStage = draft.stages.find((stage) => stage.id === oldStage.id);
    if (!nextStage || !sameLockedStage(oldStage, nextStage)) changed.add(oldStage.id);
  }
  for (const nextStage of draft.stages) {
    if (!current.stages.some((stage) => stage.id === nextStage.id)) changed.add(nextStage.id);
  }
  return [...changed];
}

function parseTitle(lines: string[]): string {
  const title = lines.find((line) => line.startsWith("# "));
  if (!title) throw new PlanParseError("missing PLAN title", 1, 1);
  return title.trim();
}

function parseMetadata(
  lines: string[],
  filePath?: string,
): Map<string, MetadataValue> {
  const metadata = new Map<string, MetadataValue>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) break;
    if (line.startsWith("#") || line.trim() === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new PlanParseError("expected metadata field in key: value form", index + 1, 1, filePath);
    }
    metadata.set(line.slice(0, separator).trim(), {
      value: line.slice(separator + 1).trim(),
      line: index + 1,
      column: separator + 2,
    });
  }
  return metadata;
}

function parseSections(lines: string[]): Map<string, MarkdownSection> {
  const sections = new Map<string, MarkdownSection>();
  let current: MarkdownSection | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      if (current) current.content = current.lines.join("\n").trim();
      current = { title: line.slice(3).trim(), line: index + 1, content: "", lines: [] };
      sections.set(current.title, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) current.content = current.lines.join("\n").trim();
  return sections;
}

function readMetadata(
  metadata: Map<string, MetadataValue>,
  key: string,
  filePath?: string,
): MetadataValue {
  const value = metadata.get(key);
  if (!value) throw new PlanParseError(`missing required metadata field ${key}`, 1, 1, filePath);
  return value;
}

function parseIntegerField(
  metadata: Map<string, MetadataValue>,
  key: string,
  filePath?: string,
): number {
  const raw = readMetadata(metadata, key, filePath);
  const parsed = Number.parseInt(raw.value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw.value) {
    throw new PlanParseError(`${key} must be an integer`, raw.line, raw.column, filePath);
  }
  return parsed;
}

function parseNumberField(
  metadata: Map<string, MetadataValue>,
  key: string,
  filePath?: string,
): number {
  const raw = readMetadata(metadata, key, filePath);
  const parsed = Number.parseFloat(raw.value);
  if (!Number.isFinite(parsed)) {
    throw new PlanParseError(`${key} must be a number`, raw.line, raw.column, filePath);
  }
  return parsed;
}

function parseDefinitionOfDone(section: MarkdownSection, filePath?: string): Verifier[] {
  return parseYamlListSection(section, filePath).map((entry, index) => {
    const result = verifierSchema.safeParse(entry);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new PlanParseError(
        `invalid verifier at index ${index}: ${first?.message ?? "unknown error"}`,
        section.line + index + 1,
        1,
        filePath,
      );
    }
    return result.data;
  });
}

function parseYamlListSection(section: MarkdownSection, filePath?: string): unknown[] {
  if (section.content.trim() === "") return [];
  const lineCounter = new LineCounter();
  const document = parseDocument(section.content, { lineCounter });
  const error = document.errors[0];
  if (error) {
    const pos = error.linePos?.[0];
    throw new PlanParseError(
      error.message,
      section.line + (pos?.line ?? 1),
      pos?.col ?? 1,
      filePath,
    );
  }
  const parsed = document.toJSON();
  return Array.isArray(parsed) ? parsed : [];
}

function parseBulletText(section: MarkdownSection): string[] {
  return section.lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function parseBracketList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBlock(value: string): string {
  return value.trim();
}

function pushBullets(lines: string[], values: string[]): void {
  if (values.length === 0) {
    lines.push("# (empty)");
    return;
  }
  for (const value of values) lines.push(`- ${value}`);
}

function serializeYamlList(values: unknown[]): string {
  if (values.length === 0) return "# (empty)";
  return stringify(values).trimEnd();
}

function listEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function appendPlanEvent(
  planPath: string,
  ctx: PlanWriteContext,
  fields: Record<string, unknown> & { event: string },
): Promise<void> {
  const workspaceDir = ctx.workspaceDir ?? path.dirname(planPath);
  await appendEvent(workspaceDir, {
    ...fields,
    event_id: crypto.randomUUID(),
    ts: isoNow(ctx),
    agent: ctx.agent ?? "main",
    session: ctx.session,
  });
}

function isoNow(ctx?: { now?: () => Date }): string {
  return (ctx?.now?.() ?? new Date()).toISOString();
}

function zodToPlanError(error: z.ZodError, filePath?: string): PlanParseError {
  const first = error.issues[0];
  const field = first?.path.length ? first.path.join(".") : "document";
  return new PlanParseError(
    `invalid PLAN ${field}: ${first?.message ?? "unknown error"}`,
    1,
    1,
    filePath,
  );
}
