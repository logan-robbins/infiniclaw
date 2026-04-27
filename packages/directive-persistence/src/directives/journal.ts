import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { appendEvent } from "../events/log.js";
import { writeFileAtomic, type AtomicWriteOptions } from "../fs/atomic.js";
import { getLatestVerifierRun } from "../verify/pass-registry.js";
import { hashDoD, type RunAllDoDResult } from "../verify/runner.js";
import {
  type Journal,
  type JournalStep,
  type Verifier,
  journalSchema,
  journalStepStatusSchema,
} from "./schema.js";

type MarkdownSection = {
  title: string;
  line: number;
  lines: string[];
};

type MetadataValue = {
  value: string;
  line: number;
};

export class JournalParseError extends Error {
  readonly filePath?: string;
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number, filePath?: string) {
    super(`${message} (${filePath ?? "JOURNAL.md"}:${line}:${column})`);
    this.name = "JournalParseError";
    this.filePath = filePath;
    this.line = line;
    this.column = column;
  }
}

export class JournalWriteRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalWriteRejectedError";
  }
}

export type JournalWriteContext = {
  workspaceDir: string;
  agent?: string;
  session?: string;
  now?: () => Date;
};

export type MarkStepDoneOptions = {
  verifiedOutputs?: string[];
  dod?: Verifier[];
};

export async function readJournal(filePath: string): Promise<Journal> {
  const content = await readFile(filePath, "utf8");
  return parseJournalContent(content, filePath);
}

export function parseJournalContent(content: string, filePath?: string): Journal {
  const lines = content.split(/\r?\n/u);
  const metadata = parseMetadata(lines, filePath);
  const sections = parseSections(lines);

  const getSection = (title: string): MarkdownSection => {
    const section = sections.get(title);
    if (!section) {
      throw new JournalParseError(
        `missing required section ## ${title}`,
        1,
        1,
        filePath,
      );
    }
    return section;
  };

  const parsed = {
    schemaVersion: parseIntegerField(metadata, "schema_version", filePath),
    agent: readMetadata(metadata, "agent", filePath).value,
    lastUpdated: readMetadata(metadata, "last_updated", filePath).value,
    turnsUsed: parseIntegerField(metadata, "turns_used", filePath),
    lastVerifierRun: nullableScalar(
      readMetadata(metadata, "last_verifier_run", filePath).value,
    ),
    turnBudget: parseTurnBudget(metadata),
    taskStack: parseTaskStack(getSection("TASK STACK"), filePath),
    workingNotes: parseBulletText(getSection("WORKING NOTES")),
    subAgents: getSection("SUB-AGENTS").lines.join("\n").trim(),
    completionReport: getSection("COMPLETION REPORT").lines.join("\n").trim(),
    raw: content,
  };

  const result = journalSchema.safeParse(parsed);
  if (!result.success) throw zodToJournalError(result.error, filePath);
  return result.data;
}

export async function writeJournalAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(filePath, content, options);
}

export async function writeParsedJournalAtomic(
  filePath: string,
  journal: Journal,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeJournalAtomic(filePath, serializeJournal(journal), options);
}

export function serializeJournal(journal: Journal): string {
  const lines: string[] = [
    "# JOURNAL",
    `schema_version: ${journal.schemaVersion}`,
    `agent: ${journal.agent}`,
    `last_updated: ${journal.lastUpdated}`,
    `turns_used: ${journal.turnsUsed}`,
  ];
  pushOptional(lines, "max_turns", journal.turnBudget?.maxTurns);
  pushOptional(lines, "warning_at", journal.turnBudget?.warningAt);
  pushOptional(lines, "escalate_at", journal.turnBudget?.escalateAt);
  lines.push(`last_verifier_run: ${journal.lastVerifierRun ?? "null"}`, "", "## TASK STACK");

  for (const step of journal.taskStack) {
    lines.push("", `#### ${step.id}: ${step.title}`, `status: ${step.status}`);
    pushOptional(lines, "started", step.started);
    pushOptional(lines, "completed", step.completed);
    pushOptional(lines, "verifier_run_id", step.verifierRunId);
    pushOptional(lines, "progress", quoteIfNeeded(step.progress));
    pushOptional(lines, "blocker", step.blocker ?? "null");
    pushOptional(lines, "turns_in_step", step.turnsInStep);
    pushArray(lines, "verified_outputs", step.verifiedOutputs);
    if (step.blackBox !== undefined) {
      lines.push(`black_box: ${step.blackBox ? "YES" : "NO"}`);
    }
    pushArray(lines, "depends_on", step.dependsOn);
    pushOptional(lines, "expected_output", quoteIfNeeded(step.expectedOutput));
    pushArray(lines, "last_verifier_failures", step.lastVerifierFailures);
  }

  lines.push("", "## WORKING NOTES");
  if (journal.workingNotes.length === 0) {
    lines.push("# (empty)");
  } else {
    for (const note of journal.workingNotes) lines.push(`- ${note}`);
  }

  lines.push("", "## SUB-AGENTS");
  if (journal.subAgents) lines.push(journal.subAgents);
  else lines.push("# (empty)");

  lines.push("", "## COMPLETION REPORT");
  if (journal.completionReport) lines.push(journal.completionReport);
  else lines.push("# Written once, at TASK_COMPLETE. Empty until then.");

  return `${lines.join("\n")}\n`;
}

export function getCurrentStep(journal: Journal): JournalStep | undefined {
  return (
    journal.taskStack.find((step) => step.status === "IN_PROGRESS") ??
    journal.taskStack.find((step) => step.status === "BLOCKED") ??
    journal.taskStack.find((step) => step.status === "PENDING") ??
    journal.taskStack.at(-1)
  );
}

export function getNextStep(journal: Journal): JournalStep | undefined {
  const current = getCurrentStep(journal);
  if (!current) return undefined;
  const currentIndex = journal.taskStack.findIndex(
    (step) => step.id === current.id,
  );
  return journal.taskStack
    .slice(currentIndex + 1)
    .find((step) => step.status === "PENDING");
}

export async function setStepProgress(
  filePath: string,
  stepId: string,
  progress: string,
  ctx: JournalWriteContext,
): Promise<Journal> {
  const journal = await readJournal(filePath);
  const step = findStep(journal, stepId);
  const beforeStatus = step.status;
  step.status = "IN_PROGRESS";
  step.progress = progress;
  step.blocker = null;
  step.started ??= isoNow(ctx);
  step.turnsInStep = (step.turnsInStep ?? 0) + 1;
  touchJournal(journal, ctx);
  await writeParsedJournalAtomic(filePath, journal);
  await emitJournalWrite(ctx, journal.agent, {
    [stepId]: `status ${beforeStatus} → IN_PROGRESS; progress updated`,
  });
  await maybeEmitBudgetWarning(ctx, journal);
  return journal;
}

export async function markStepBlocked(
  filePath: string,
  stepId: string,
  blocker: string,
  ctx: JournalWriteContext,
): Promise<Journal> {
  const journal = await readJournal(filePath);
  const step = findStep(journal, stepId);
  const beforeStatus = step.status;
  step.status = "BLOCKED";
  step.blocker = blocker;
  step.turnsInStep = (step.turnsInStep ?? 0) + 1;
  touchJournal(journal, ctx);
  await writeParsedJournalAtomic(filePath, journal);
  await emitJournalWrite(ctx, journal.agent, {
    [stepId]: `status ${beforeStatus} → BLOCKED`,
  });
  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:BLOCKED",
    event_id: crypto.randomUUID(),
    ts: journal.lastUpdated,
    agent: ctx.agent ?? journal.agent,
    session: ctx.session,
    step: stepId,
    reason: blocker,
  });
  await maybeEmitBudgetWarning(ctx, journal);
  return journal;
}

export async function recordVerifierRunInJournal(
  filePath: string,
  stepId: string,
  run: RunAllDoDResult & { verifierRunId: string },
  ctx: JournalWriteContext,
): Promise<Journal> {
  const journal = await readJournal(filePath);
  const step = findStep(journal, stepId);
  const failures = run.results
    .filter(({ result }) => !result.pass)
    .map(({ verifier, result }) =>
      [
        `${verifier.type}: ${result.detail}`,
        result.evidence ? result.evidence.slice(0, 500) : "",
      ]
        .filter(Boolean)
        .join(" — "),
    );
  step.lastVerifierFailures = failures;
  journal.lastVerifierRun = isoNow(ctx);
  if (failures.length > 0) {
    journal.workingNotes.push(
      `Verifier ${run.verifierRunId} failed for ${stepId}: ${failures.join("; ")}`,
    );
  }
  touchJournal(journal, ctx, { preserveLastVerifierRun: true });
  await writeParsedJournalAtomic(filePath, journal);
  await emitJournalWrite(ctx, journal.agent, {
    [stepId]: failures.length
      ? "verifier failures recorded in WORKING NOTES"
      : "verifier pass recorded",
  });
  await maybeEmitBudgetWarning(ctx, journal);
  return journal;
}

export async function markStepDone(
  filePath: string,
  stepId: string,
  ctx: JournalWriteContext,
  options: MarkStepDoneOptions = {},
): Promise<Journal> {
  const journal = await readJournal(filePath);
  const agent = ctx.agent ?? journal.agent;
  const latestRun = getLatestVerifierRun(agent, stepId);
  if (!latestRun) {
    throw new JournalWriteRejectedError(
      `cannot mark ${stepId} DONE: no verifier run recorded for ${agent}`,
    );
  }
  if (!latestRun.allPass) {
    throw new JournalWriteRejectedError(
      `cannot mark ${stepId} DONE: latest verifier run ${latestRun.verifierRunId} failed`,
    );
  }
  if (options.dod && latestRun.dodHash !== hashDoD(options.dod)) {
    throw new JournalWriteRejectedError(
      `cannot mark ${stepId} DONE: verifier run DoD hash does not match current DoD`,
    );
  }

  const step = findStep(journal, stepId);
  const beforeStatus = step.status;
  step.status = "DONE";
  step.completed = isoNow(ctx);
  step.verifierRunId = latestRun.verifierRunId;
  step.verifiedOutputs = options.verifiedOutputs ?? step.verifiedOutputs ?? [];
  step.blackBox = true;
  step.blocker = null;
  step.lastVerifierFailures = [];

  const next = journal.taskStack
    .slice(journal.taskStack.findIndex((item) => item.id === stepId) + 1)
    .find((item) => item.status === "PENDING");
  if (next) {
    next.status = "IN_PROGRESS";
    next.started ??= isoNow(ctx);
  }

  journal.workingNotes = [];
  journal.lastVerifierRun = latestRun.ts;
  touchJournal(journal, ctx, { preserveLastVerifierRun: true });
  await writeParsedJournalAtomic(filePath, journal);
  await emitJournalWrite(ctx, journal.agent, {
    [stepId]: `status ${beforeStatus} → DONE`,
    ...(next ? { [next.id]: "status PENDING → IN_PROGRESS" } : {}),
  });
  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:STEP_COMPLETE",
    event_id: crypto.randomUUID(),
    ts: journal.lastUpdated,
    agent,
    session: ctx.session,
    step: stepId,
    verifier_run_id: latestRun.verifierRunId,
    outputs: step.verifiedOutputs,
  });
  await maybeEmitBudgetWarning(ctx, journal);
  return journal;
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
      throw new JournalParseError(
        "expected metadata field in key: value form",
        index + 1,
        1,
        filePath,
      );
    }
    metadata.set(line.slice(0, separator).trim(), {
      value: line.slice(separator + 1).trim(),
      line: index + 1,
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
      current = { title: line.slice(3).trim(), line: index + 1, lines: [] };
      sections.set(current.title, current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  return sections;
}

function readMetadata(
  metadata: Map<string, MetadataValue>,
  key: string,
  filePath?: string,
): MetadataValue {
  const value = metadata.get(key);
  if (!value) {
    throw new JournalParseError(
      `missing required metadata field ${key}`,
      1,
      1,
      filePath,
    );
  }
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
    throw new JournalParseError(
      `${key} must be an integer`,
      raw.line,
      1,
      filePath,
    );
  }
  return parsed;
}

function parseTurnBudget(metadata: Map<string, MetadataValue>) {
  const maxTurns = optionalInteger(metadata.get("max_turns")?.value);
  const warningAt = optionalInteger(metadata.get("warning_at")?.value);
  const escalateAt = optionalInteger(metadata.get("escalate_at")?.value);
  if (maxTurns === undefined && warningAt === undefined && escalateAt === undefined) {
    return undefined;
  }
  return { maxTurns, warningAt, escalateAt };
}

function optionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function nullableScalar(value: string): string | null {
  if (value === "null" || value === "~" || value === "") return null;
  return unquote(value);
}

function parseTaskStack(section: MarkdownSection, filePath?: string): JournalStep[] {
  const steps: JournalStep[] = [];
  let current: {
    id: string;
    title: string;
    line: number;
    lines: string[];
  } | undefined;

  const flush = () => {
    if (!current) return;
    steps.push(parseStep(current.id, current.title, current.line, current.lines, filePath));
  };

  for (let index = 0; index < section.lines.length; index += 1) {
    const line = section.lines[index] ?? "";
    if (line.startsWith("#### ")) {
      flush();
      const heading = line.slice(5).trim();
      const separator = heading.indexOf(":");
      current =
        separator === -1
          ? { id: heading, title: heading, line: section.line + index + 1, lines: [] }
          : {
              id: heading.slice(0, separator).trim(),
              title: heading.slice(separator + 1).trim(),
              line: section.line + index + 1,
              lines: [],
            };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return steps;
}

function parseStep(
  id: string,
  title: string,
  line: number,
  lines: string[],
  filePath?: string,
): JournalStep {
  const fields = parseKeyValues(lines);
  const statusRaw = scalarValue(fields.get("status"));
  const status = journalStepStatusSchema.safeParse(statusRaw);
  if (!status.success) {
    throw new JournalParseError(
      `invalid or missing status for ${id}`,
      line,
      1,
      filePath,
    );
  }

  return {
    id,
    title,
    line,
    status: status.data,
    started: nullableMaybe(fields.get("started")),
    completed: nullableMaybe(fields.get("completed")),
    progress: nullableMaybe(fields.get("progress")),
    blocker: nullableMaybe(fields.get("blocker")),
    turnsInStep: numberMaybe(fields.get("turns_in_step")),
    verifierRunId: nullableMaybe(fields.get("verifier_run_id")),
    verifiedOutputs: arrayValue(fields.get("verified_outputs")),
    blackBox: booleanMaybe(fields.get("black_box")),
    dependsOn: arrayValue(fields.get("depends_on")),
    expectedOutput: scalarValue(fields.get("expected_output")) ?? undefined,
    lastVerifierFailures: arrayValue(fields.get("last_verifier_failures")),
    rawFields: Object.fromEntries(fields),
  };
}

function parseKeyValues(lines: string[]): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  let activeArrayKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (activeArrayKey && line.startsWith("- ")) {
      const current = fields.get(activeArrayKey);
      if (Array.isArray(current)) current.push(line.slice(2).trim());
      continue;
    }

    activeArrayKey = undefined;
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value === "") {
      fields.set(key, []);
      activeArrayKey = key;
    } else {
      fields.set(key, value);
    }
  }
  return fields;
}

function parseBulletText(section: MarkdownSection): string[] {
  return section.lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function scalarValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return unquote(value);
}

function nullableMaybe(value: string | string[] | undefined): string | null | undefined {
  const scalar = scalarValue(value);
  if (scalar === undefined) return undefined;
  if (scalar === "null" || scalar === "~") return null;
  return scalar;
}

function numberMaybe(value: string | string[] | undefined): number | undefined {
  const scalar = scalarValue(value);
  if (scalar === undefined) return undefined;
  const parsed = Number.parseInt(scalar, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function booleanMaybe(value: string | string[] | undefined): boolean | undefined {
  const scalar = scalarValue(value);
  if (scalar === undefined) return undefined;
  if (scalar === "YES" || scalar === "true") return true;
  if (scalar === "NO" || scalar === "false") return false;
  return undefined;
}

function arrayValue(value: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(value)) return value.map(unquote);
  if (typeof value === "string" && value === "[]") return [];
  return undefined;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteIfNeeded(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (/[:#\[\]{}]/u.test(value)) return JSON.stringify(value);
  return value;
}

function pushOptional(
  lines: string[],
  key: string,
  value: string | number | null | undefined,
): void {
  if (value === undefined) return;
  lines.push(`${key}: ${value ?? "null"}`);
}

function pushArray(
  lines: string[],
  key: string,
  value: string[] | undefined,
): void {
  if (!value) return;
  if (value.length === 0) {
    lines.push(`${key}: []`);
    return;
  }
  lines.push(`${key}:`);
  for (const item of value) lines.push(`  - ${item}`);
}

function zodToJournalError(error: z.ZodError, filePath?: string): JournalParseError {
  const first = error.issues[0];
  const path = first?.path.length ? first.path.join(".") : "document";
  return new JournalParseError(
    `invalid JOURNAL ${path}: ${first?.message ?? "unknown error"}`,
    1,
    1,
    filePath,
  );
}

function findStep(journal: Journal, stepId: string): JournalStep {
  const step = journal.taskStack.find((item) => item.id === stepId);
  if (!step) throw new JournalWriteRejectedError(`unknown JOURNAL step ${stepId}`);
  return step;
}

function touchJournal(
  journal: Journal,
  ctx: JournalWriteContext,
  options: { preserveLastVerifierRun?: boolean } = {},
): void {
  journal.lastUpdated = isoNow(ctx);
  journal.turnsUsed += 1;
  if (!options.preserveLastVerifierRun) {
    journal.lastVerifierRun ??= null;
  }
}

function isoNow(ctx: JournalWriteContext): string {
  return (ctx.now?.() ?? new Date()).toISOString();
}

async function emitJournalWrite(
  ctx: JournalWriteContext,
  fallbackAgent: string,
  diff: Record<string, string>,
): Promise<void> {
  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:JOURNAL_WRITE",
    event_id: crypto.randomUUID(),
    ts: isoNow(ctx),
    agent: ctx.agent ?? fallbackAgent,
    session: ctx.session,
    diff,
  });
}

async function maybeEmitBudgetWarning(
  ctx: JournalWriteContext,
  journal: Journal,
): Promise<void> {
  const warningAt = journal.turnBudget?.warningAt;
  const maxTurns = journal.turnBudget?.maxTurns;
  if (warningAt === undefined || maxTurns === undefined) return;
  if (journal.turnsUsed < warningAt) return;
  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:BUDGET_WARNING",
    event_id: crypto.randomUUID(),
    ts: journal.lastUpdated,
    agent: ctx.agent ?? journal.agent,
    session: ctx.session,
    turns_used: journal.turnsUsed,
    turn_budget: maxTurns,
    pct: maxTurns === 0 ? 1 : journal.turnsUsed / maxTurns,
  });
}
