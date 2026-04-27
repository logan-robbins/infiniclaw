import crypto from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  inventoryEntrySchema,
  inventorySchema,
  type Inventory,
  type InventoryEntry,
} from "../directives/schema.js";
import { appendEvent } from "../events/log.js";
import { fileExists, writeFileAtomic } from "../fs/atomic.js";

type InventoryWriteContext = {
  workspaceDir: string;
  agent?: string;
  session?: string;
  now?: () => Date;
};

export type ServiceCardInput = {
  name: string;
  stage: string;
  path: string;
  summary: string;
  sealed?: string;
  ownerAgent?: string;
  purpose?: string;
  interfaceMarkdown?: string;
  howToUse?: string;
  dependsOn?: string[];
  verifierSnippets?: string[];
  doNot?: string[];
  content?: string;
};

export class InventoryParseError extends Error {
  readonly filePath?: string;
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number, filePath?: string) {
    super(`${message} (${filePath ?? "INVENTORY.md"}:${line}:${column})`);
    this.name = "InventoryParseError";
    this.filePath = filePath;
    this.line = line;
    this.column = column;
  }
}

export class InventoryWriteRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryWriteRejectedError";
  }
}

export async function readInventory(filePath: string): Promise<Inventory> {
  const content = await readFile(filePath, "utf8");
  return parseInventoryContent(content, filePath);
}

export function parseInventoryContent(
  content: string,
  filePath?: string,
): Inventory {
  const lines = content.split(/\r?\n/u);
  const schemaLine = lines.findIndex((line) => line.startsWith("schema_version:"));
  if (schemaLine === -1) {
    throw new InventoryParseError(
      "missing required metadata field schema_version",
      1,
      1,
      filePath,
    );
  }
  const schemaVersion = Number.parseInt(
    (lines[schemaLine] ?? "").slice("schema_version:".length).trim(),
    10,
  );
  if (!Number.isInteger(schemaVersion)) {
    throw new InventoryParseError(
      "schema_version must be an integer",
      schemaLine + 1,
      1,
      filePath,
    );
  }

  const entries = lines
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.startsWith("- "))
    .map(({ line, number }) => parseInventoryEntryLine(line, number, filePath));

  const result = inventorySchema.safeParse({ schemaVersion, entries });
  if (!result.success) throw zodToInventoryError(result.error, filePath);
  return result.data;
}

export async function ensureInventory(
  filePath: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  if (!options.overwrite && (await fileExists(filePath))) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, serializeInventory({ schemaVersion: 1, entries: [] }));
}

export function serializeInventory(inventory: Inventory): string {
  const lines = [
    "# INVENTORY",
    `schema_version: ${inventory.schemaVersion}`,
    "# One line per sealed output. Append-only. Sorted by stage order, not time.",
    "",
  ];
  for (const entry of inventory.entries) {
    lines.push(formatInventoryEntry(entry));
  }
  return `${lines.join("\n")}\n`;
}

export async function appendInventoryEntry(
  filePath: string,
  entry: InventoryEntry,
  ctx?: InventoryWriteContext,
): Promise<InventoryEntry> {
  const parsedEntry = inventoryEntrySchema.parse(entry);
  await ensureInventory(filePath);
  const inventory = await readInventory(filePath);
  const duplicate = inventory.entries.find(
    (item) => item.name === parsedEntry.name || item.path === parsedEntry.path,
  );
  if (duplicate) {
    throw new InventoryWriteRejectedError(
      `inventory entry already exists for ${duplicate.name} at ${duplicate.path}`,
    );
  }

  const handle = await open(filePath, constants.O_APPEND | constants.O_WRONLY);
  try {
    await handle.write(`${formatInventoryEntry(parsedEntry)}\n`, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (ctx) {
    await appendEvent(ctx.workspaceDir, {
      event: "AGENT:INVENTORY_ENTRY_ADDED",
      event_id: crypto.randomUUID(),
      ts: isoNow(ctx),
      agent: ctx.agent,
      session: ctx.session,
      name: parsedEntry.name,
      stage: parsedEntry.stage,
      path: parsedEntry.path,
    });
  }

  return parsedEntry;
}

export async function writeServiceCard(
  workspaceDir: string,
  card: ServiceCardInput,
  ctx?: InventoryWriteContext,
): Promise<string> {
  const targetPath = path.resolve(workspaceDir, card.path);
  if (!(targetPath === workspaceDir || targetPath.startsWith(`${workspaceDir}${path.sep}`))) {
    throw new InventoryWriteRejectedError(
      `service card path must be inside workspace: ${card.path}`,
    );
  }
  if (await fileExists(targetPath)) {
    throw new InventoryWriteRejectedError(
      `service card already exists at ${card.path}`,
    );
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  const content = card.content ?? buildServiceCard(card, ctx);
  await writeFileAtomic(targetPath, content);
  return content;
}

export async function preSpawnReuseCheck(
  inventoryPath: string,
  intent: string,
): Promise<
  | { reuse: true; entry: InventoryEntry; message: string }
  | { reuse: false; message: string }
> {
  if (!(await fileExists(inventoryPath))) {
    return { reuse: false, message: "INVENTORY.md is absent; no reusable service found." };
  }
  const inventory = await readInventory(inventoryPath);
  const entry = findReusableService(inventory, intent);
  if (!entry) return { reuse: false, message: "No matching sealed service found." };
  return {
    reuse: true,
    entry,
    message: `Reuse sealed service ${entry.name} from ${entry.path}; consume it as a black box.`,
  };
}

export function findReusableService(
  inventory: Inventory,
  intent: string,
): InventoryEntry | undefined {
  const intentTokens = tokenize(intent);
  if (intentTokens.size === 0) return undefined;

  let best: { entry: InventoryEntry; score: number } | undefined;
  for (const entry of inventory.entries) {
    const haystack = tokenize(`${entry.name} ${entry.summary} ${entry.path}`);
    let score = 0;
    for (const token of intentTokens) {
      if (haystack.has(token)) score += token.length > 3 ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best?.score && best.score >= 2 ? best.entry : undefined;
}

export function buildServiceCard(
  card: ServiceCardInput,
  ctx?: InventoryWriteContext,
): string {
  const sealed = card.sealed ?? isoNow(ctx);
  const owner = card.ownerAgent ?? ctx?.agent ?? "main";
  const lines = [
    `# Service: ${card.name}`,
    "schema_version: 1",
    `stage: ${card.stage}`,
    `sealed: ${sealed}`,
    `owner_agent: ${owner}`,
    "",
    "## Purpose",
    card.purpose ?? card.summary,
    "",
    "## Interface",
    card.interfaceMarkdown ?? card.summary,
    "",
    "## How to use",
    card.howToUse ?? "Consume this sealed output via the interface above.",
    "",
    "## Depends on (black-box)",
  ];
  pushBullets(lines, card.dependsOn);
  lines.push("", "## Verifier snippets (for downstream consumers)");
  pushBullets(lines, card.verifierSnippets);
  lines.push("", "## Do NOT");
  pushBullets(lines, card.doNot ?? ["Read the implementation to understand behavior; use this card."]);
  return `${lines.join("\n")}\n`;
}

function parseInventoryEntryLine(
  line: string,
  lineNumber: number,
  filePath?: string,
): InventoryEntry {
  const parts = line
    .slice(2)
    .split("|")
    .map((part) => part.trim());
  if (parts.length !== 4) {
    throw new InventoryParseError(
      "inventory entries must be '- name | stage | path | summary'",
      lineNumber,
      1,
      filePath,
    );
  }
  const [name, stage, entryPath, summary] = parts;
  const result = inventoryEntrySchema.safeParse({
    name,
    stage,
    path: entryPath,
    summary,
  });
  if (!result.success) throw zodToInventoryError(result.error, filePath);
  return result.data;
}

function formatInventoryEntry(entry: InventoryEntry): string {
  return `- ${entry.name} | ${entry.stage} | ${entry.path} | ${entry.summary}`;
}

function pushBullets(lines: string[], values: string[] | undefined): void {
  if (!values || values.length === 0) {
    lines.push("- none");
    return;
  }
  for (const value of values) lines.push(`- ${value}`);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function isoNow(ctx?: { now?: () => Date }): string {
  return (ctx?.now?.() ?? new Date()).toISOString();
}

function zodToInventoryError(
  error: z.ZodError,
  filePath?: string,
): InventoryParseError {
  const first = error.issues[0];
  const field = first?.path.length ? first.path.join(".") : "document";
  return new InventoryParseError(
    `invalid INVENTORY ${field}: ${first?.message ?? "unknown error"}`,
    1,
    1,
    filePath,
  );
}
