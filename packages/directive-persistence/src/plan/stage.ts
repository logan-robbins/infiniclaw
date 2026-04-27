import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LineCounter, parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  stageSchema,
  verifierSchema,
  type StageFile,
  type Verifier,
} from "../directives/schema.js";
import { appendEvent } from "../events/log.js";
import { writeFileAtomic } from "../fs/atomic.js";

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

export type StageWriteContext = {
  workspaceDir?: string;
  agent?: string;
  session?: string;
  now?: () => Date;
};

export class StageParseError extends Error {
  readonly filePath?: string;
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number, filePath?: string) {
    super(`${message} (${filePath ?? "stage.md"}:${line}:${column})`);
    this.name = "StageParseError";
    this.filePath = filePath;
    this.line = line;
    this.column = column;
  }
}

export class StageWriteRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageWriteRejectedError";
  }
}

export async function readStage(filePath: string): Promise<StageFile> {
  const content = await readFile(filePath, "utf8");
  return parseStageContent(content, filePath);
}

export function parseStageContent(content: string, filePath?: string): StageFile {
  const lines = content.split(/\r?\n/u);
  const metadata = parseMetadata(lines, filePath);
  const sections = parseSections(lines);
  const getSection = (name: string): MarkdownSection =>
    sections.get(name) ?? { title: name, line: lines.length + 1, content: "", lines: [] };

  const parsed = {
    title: parseTitle(lines),
    schemaVersion: parseIntegerField(metadata, "schema_version", filePath),
    status: readMetadata(metadata, "status", filePath).value,
    created: readMetadata(metadata, "created", filePath).value,
    activated: nullableScalar(readMetadata(metadata, "activated", filePath).value),
    sealed: nullableScalar(readMetadata(metadata, "sealed", filePath).value),
    turnBudget: parseIntegerField(metadata, "turn_budget", filePath),
    dependsOn: parseDependsOn(getSection("Depends On"), filePath),
    outputContract: parseOutputContract(getSection("Output Contract"), filePath),
    definitionOfDone: parseDefinitionOfDone(getSection("Definition of Done"), filePath),
    subTasks: parseSubTasks(getSection("Sub-Tasks"), filePath),
    contextForSubAgents: parseBulletText(getSection("Context for Sub-Agents")),
    executionLog: parseLogLines(getSection("Execution Log")),
    sealedSummary: getSection("SEALED SUMMARY").content,
    raw: content,
  };

  const result = stageSchema.safeParse(parsed);
  if (!result.success) throw zodToStageError(result.error, filePath);
  return result.data;
}

export async function writeStageAtomic(
  filePath: string,
  stage: StageFile,
): Promise<void> {
  await writeFileAtomic(filePath, serializeStage(stage));
}

export function serializeStage(stage: StageFile): string {
  const lines = [
    stage.title,
    `schema_version: ${stage.schemaVersion}`,
    `status: ${stage.status}`,
    `created: ${stage.created}`,
    `activated: ${stage.activated ?? "null"}`,
    `sealed: ${stage.sealed ?? "null"}`,
    `turn_budget: ${stage.turnBudget}`,
    "",
    "## Depends On",
    serializeYamlList(stage.dependsOn),
    "",
    "## Output Contract",
    serializeYamlList(stage.outputContract),
    "",
    "## Definition of Done",
    serializeYamlList(stage.definitionOfDone),
    "",
    "## Sub-Tasks",
    serializeSubTasks(stage.subTasks),
    "",
    "## Context for Sub-Agents",
  ];
  pushBullets(lines, stage.contextForSubAgents);
  lines.push("", "## Execution Log");
  if (stage.executionLog.length === 0) lines.push("# (empty)");
  else lines.push(...stage.executionLog);
  lines.push("", "## SEALED SUMMARY");
  lines.push(stage.sealedSummary || "# (empty)");
  return `${lines.join("\n")}\n`;
}

export async function activateStageFile(
  filePath: string,
  ctx: StageWriteContext = {},
): Promise<StageFile> {
  const stage = await readStage(filePath);
  if (stage.status !== "PENDING") {
    throw new StageWriteRejectedError(
      `cannot activate stage file ${filePath}: expected PENDING, found ${stage.status}`,
    );
  }
  stage.status = "ACTIVE";
  stage.activated = isoNow(ctx);
  stage.executionLog.push(`- ${stage.activated}  ACTIVATED`);
  await writeStageAtomic(filePath, stage);
  await appendStageEvent(filePath, ctx, {
    event: "AGENT:STAGE_ACTIVATED",
    stage: stageIdFromPath(filePath),
  });
  return stage;
}

export async function replacePendingStageFile(
  filePath: string,
  draftContent: string,
): Promise<StageFile> {
  const current = await readStage(filePath);
  if (current.status !== "PENDING") {
    throw new StageWriteRejectedError(
      `REPLAN rejected: ${current.status} stage file is frozen`,
    );
  }
  const draft = parseStageContent(draftContent, filePath);
  if (draft.status !== "PENDING") {
    throw new StageWriteRejectedError("REPLAN draft stage file must remain PENDING");
  }
  await writeStageAtomic(filePath, draft);
  return draft;
}

export async function sealStageFile(
  filePath: string,
  summary: string,
  ctx: StageWriteContext = {},
): Promise<StageFile> {
  const stage = await readStage(filePath);
  if (stage.status !== "ACTIVE") {
    throw new StageWriteRejectedError(
      `cannot seal stage file ${filePath}: expected ACTIVE, found ${stage.status}`,
    );
  }
  stage.status = "SEALED";
  stage.sealed = isoNow(ctx);
  stage.executionLog.push(`- ${stage.sealed}  STAGE SEALED`);
  stage.sealedSummary = summary;
  await writeStageAtomic(filePath, stage);
  return stage;
}

function parseDependsOn(section: MarkdownSection, filePath?: string) {
  return parseYamlListSection(section, filePath).map((entry, index) => {
    if (typeof entry === "string") {
      return { service: entry };
    }
    const value = entry as Record<string, unknown>;
    const service = typeof value.service === "string" ? value.service : "";
    const requiredSections = Array.isArray(value.required_sections)
      ? value.required_sections.map(String)
      : Array.isArray(value.requiredSections)
        ? value.requiredSections.map(String)
        : undefined;
    if (!service) {
      throw new StageParseError(
        `invalid dependency at index ${index}: missing service`,
        section.line + index + 1,
        1,
        filePath,
      );
    }
    return { service, requiredSections };
  });
}

function parseOutputContract(section: MarkdownSection, filePath?: string) {
  return parseYamlListSection(section, filePath).map((entry, index) => {
    const value = entry as Record<string, unknown>;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new StageParseError(
        `invalid output contract at index ${index}`,
        section.line + index + 1,
        1,
        filePath,
      );
    }
    return {
      kind: String(value.kind ?? ""),
      path: String(value.path ?? ""),
      exports: Array.isArray(value.exports) ? value.exports.map(String) : undefined,
      interface: typeof value.interface === "string" ? value.interface : undefined,
    };
  });
}

function parseDefinitionOfDone(section: MarkdownSection, filePath?: string): Verifier[] {
  return parseYamlListSection(section, filePath).map((entry, index) => {
    const result = verifierSchema.safeParse(entry);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new StageParseError(
        `invalid verifier at index ${index}: ${first?.message ?? "unknown error"}`,
        section.line + index + 1,
        1,
        filePath,
      );
    }
    return result.data;
  });
}

function parseSubTasks(section: MarkdownSection, filePath?: string) {
  if (!section.content.trim()) return [];
  const parsed = parseYamlValue(section, filePath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
    const task = value as Record<string, unknown>;
    const inputContract = Array.isArray(task.input_contract)
      ? task.input_contract.map((item, index) => ({
          raw: stringifyInline(item),
          line: section.line + index + 1,
        }))
      : [];
    const outputContract = Array.isArray(task.output_contract)
      ? task.output_contract.map((item, index) => ({
          raw: stringifyInline(item),
          line: section.line + index + 1,
        }))
      : [];
    return {
      key,
      id: String(task.id ?? key),
      goal: String(task.goal ?? ""),
      inputContract,
      outputContract,
      canStart: typeof task.can_start === "string" ? task.can_start : undefined,
      turnBudget:
        typeof task.turn_budget === "number" && Number.isInteger(task.turn_budget)
          ? task.turn_budget
          : undefined,
      preset: typeof task.preset === "string" ? task.preset : undefined,
    };
  });
}

function parseYamlListSection(section: MarkdownSection, filePath?: string): unknown[] {
  if (section.content.trim() === "" || section.content.trim() === "# (empty)") return [];
  const parsed = parseYamlValue(section, filePath);
  return Array.isArray(parsed) ? parsed : [];
}

function parseYamlValue(section: MarkdownSection, filePath?: string): unknown {
  const lineCounter = new LineCounter();
  const document = parseDocument(section.content, { lineCounter });
  const error = document.errors[0];
  if (error) {
    const pos = error.linePos?.[0];
    throw new StageParseError(
      error.message,
      section.line + (pos?.line ?? 1),
      pos?.col ?? 1,
      filePath,
    );
  }
  return document.toJSON();
}

function parseTitle(lines: string[]): string {
  const title = lines.find((line) => line.startsWith("# "));
  if (!title) throw new StageParseError("missing stage title", 1, 1);
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
      throw new StageParseError(
        "expected metadata field in key: value form",
        index + 1,
        1,
        filePath,
      );
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
  if (!value) throw new StageParseError(`missing required metadata field ${key}`, 1, 1, filePath);
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
    throw new StageParseError(`${key} must be an integer`, raw.line, raw.column, filePath);
  }
  return parsed;
}

function nullableScalar(value: string): string | null {
  if (value === "null" || value === "~" || value === "") return null;
  return value;
}

function parseBulletText(section: MarkdownSection): string[] {
  return section.lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function parseLogLines(section: MarkdownSection): string[] {
  return section.lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
}

function serializeYamlList(values: unknown[]): string {
  if (values.length === 0) return "# (empty)";
  return stringify(values).trimEnd();
}

function serializeSubTasks(tasks: StageFile["subTasks"]): string {
  if (tasks.length === 0) return "# (empty)";
  const mapped = Object.fromEntries(
    tasks.map((task) => [
      task.key,
      {
        id: task.id,
        goal: task.goal,
        input_contract: task.inputContract.map((entry) => entry.raw),
        output_contract: task.outputContract.map((entry) => entry.raw),
        can_start: task.canStart,
        turn_budget: task.turnBudget,
        preset: task.preset,
      },
    ]),
  );
  return stringify(mapped).trimEnd();
}

function pushBullets(lines: string[], values: string[]): void {
  if (values.length === 0) {
    lines.push("# (empty)");
    return;
  }
  for (const value of values) lines.push(`- ${value}`);
}

function stringifyInline(value: unknown): string {
  if (typeof value === "string") return value;
  return stringify(value).trim().replace(/\n+/gu, " ");
}

async function appendStageEvent(
  stagePath: string,
  ctx: StageWriteContext,
  fields: Record<string, unknown> & { event: string },
): Promise<void> {
  await appendEvent(ctx.workspaceDir ?? path.dirname(path.dirname(stagePath)), {
    ...fields,
    event_id: crypto.randomUUID(),
    ts: isoNow(ctx),
    agent: ctx.agent ?? "main",
    session: ctx.session,
  });
}

function stageIdFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function isoNow(ctx?: { now?: () => Date }): string {
  return (ctx?.now?.() ?? new Date()).toISOString();
}

function zodToStageError(error: z.ZodError, filePath?: string): StageParseError {
  const first = error.issues[0];
  const field = first?.path.length ? first.path.join(".") : "document";
  return new StageParseError(
    `invalid stage ${field}: ${first?.message ?? "unknown error"}`,
    1,
    1,
    filePath,
  );
}
