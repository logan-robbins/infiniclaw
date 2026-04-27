import { readFile } from "node:fs/promises";
import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import {
  type Directives,
  type Verifier,
  directivesSchema,
  outputContractEntrySchema,
  verifierSchema,
} from "./schema.js";

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

export class DirectivesParseError extends Error {
  readonly filePath?: string;
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number, filePath?: string) {
    super(`${message} (${filePath ?? "DIRECTIVES.md"}:${line}:${column})`);
    this.name = "DirectivesParseError";
    this.filePath = filePath;
    this.line = line;
    this.column = column;
  }
}

export async function parseDirectives(filePath: string): Promise<Directives> {
  const content = await readFile(filePath, "utf8");
  return parseDirectivesContent(content, filePath);
}

export function parseDirectivesContent(
  content: string,
  filePath?: string,
): Directives {
  const lines = content.split(/\r?\n/u);
  const metadata = parseMetadata(lines, filePath);
  const sections = parseSections(lines);

  const getSection = (title: string): MarkdownSection => {
    const section = sections.get(title);
    if (!section) {
      throw new DirectivesParseError(
        `missing required section ## ${title}`,
        1,
        1,
        filePath,
      );
    }
    return section;
  };

  const dodSection = getSection("DEFINITION OF DONE");
  const parsed = {
    schemaVersion: parseIntegerField(metadata, "schema_version", filePath),
    agent: readMetadata(metadata, "agent", filePath).value,
    parent: nullableScalar(readMetadata(metadata, "parent", filePath).value),
    workspace: readMetadata(metadata, "workspace", filePath).value,
    spawned: readMetadata(metadata, "spawned", filePath).value,
    journal: readMetadata(metadata, "journal", filePath).value,
    goal: normalizeBlock(getSection("GOAL").content),
    inputContract: parseBulletEntries(getSection("INPUT CONTRACT")),
    outputContract: parseOutputContract(getSection("OUTPUT CONTRACT")),
    definitionOfDone: parseDefinitionOfDone(dodSection, filePath),
    constraints: parseBulletText(getSection("CONSTRAINTS")),
    turnBudget: parseTurnBudget(getSection("TURN BUDGET"), filePath),
    initialDecomposition: parseInitialDecomposition(
      getSection("INITIAL DECOMPOSITION"),
    ),
    protocol: normalizeBlock(getSection("PROTOCOL").content),
    raw: content,
  };

  const result = directivesSchema.safeParse(parsed);
  if (!result.success) {
    throw zodToDirectivesError(result.error, filePath);
  }
  return result.data;
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
      throw new DirectivesParseError(
        "expected metadata field in key: value form",
        index + 1,
        1,
        filePath,
      );
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) {
      throw new DirectivesParseError(
        "metadata key cannot be empty",
        index + 1,
        1,
        filePath,
      );
    }
    metadata.set(key, { value, line: index + 1, column: separator + 2 });
  }
  return metadata;
}

function parseSections(lines: string[]): Map<string, MarkdownSection> {
  const sections = new Map<string, MarkdownSection>();
  let current: MarkdownSection | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      if (current) {
        current.content = current.lines.join("\n").trim();
      }
      const title = line.slice(3).trim();
      current = { title, line: index + 1, content: "", lines: [] };
      sections.set(title, current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (current) {
    current.content = current.lines.join("\n").trim();
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
    throw new DirectivesParseError(
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
    throw new DirectivesParseError(
      `${key} must be an integer`,
      raw.line,
      raw.column,
      filePath,
    );
  }
  return parsed;
}

function parseTurnBudget(section: MarkdownSection, filePath?: string) {
  const fields = parseSectionKeyValues(section, filePath);
  return {
    maxTurns: parseSectionInteger(fields, "max_turns", section, filePath),
    warningAt: parseOptionalSectionInteger(fields, "warning_at", section, filePath),
    escalateAt: parseOptionalSectionInteger(fields, "escalate_at", section, filePath),
  };
}

function parseSectionKeyValues(
  section: MarkdownSection,
  filePath?: string,
): Map<string, MetadataValue> {
  const fields = new Map<string, MetadataValue>();
  for (let offset = 0; offset < section.lines.length; offset += 1) {
    const line = section.lines[offset] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new DirectivesParseError(
        `expected ${section.title} field in key: value form`,
        section.line + offset + 1,
        1,
        filePath,
      );
    }
    const key = line.slice(0, separator).trim();
    fields.set(key, {
      value: line.slice(separator + 1).trim(),
      line: section.line + offset + 1,
      column: separator + 2,
    });
  }
  return fields;
}

function parseSectionInteger(
  fields: Map<string, MetadataValue>,
  key: string,
  section: MarkdownSection,
  filePath?: string,
): number {
  const raw = fields.get(key);
  if (!raw) {
    throw new DirectivesParseError(
      `missing required ${section.title} field ${key}`,
      section.line,
      1,
      filePath,
    );
  }
  const parsed = Number.parseInt(raw.value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw.value) {
    throw new DirectivesParseError(
      `${key} must be an integer`,
      raw.line,
      raw.column,
      filePath,
    );
  }
  return parsed;
}

function parseOptionalSectionInteger(
  fields: Map<string, MetadataValue>,
  key: string,
  section: MarkdownSection,
  filePath?: string,
): number | undefined {
  const raw = fields.get(key);
  if (!raw || raw.value === "") return undefined;
  const parsed = Number.parseInt(raw.value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw.value) {
    throw new DirectivesParseError(
      `${key} must be an integer`,
      raw.line,
      raw.column,
      filePath,
    );
  }
  return parsed;
}

function nullableScalar(value: string): string | null {
  if (value === "null" || value === "~") return null;
  return value;
}

function normalizeBlock(value: string): string {
  return value.trim();
}

function parseBulletEntries(section: MarkdownSection) {
  return section.lines
    .map((line, offset) => ({ raw: line.trim(), line: section.line + 1 + offset }))
    .filter((entry) => entry.raw.startsWith("- "))
    .map((entry) => ({ raw: entry.raw.slice(2).trim(), line: entry.line }));
}

function parseBulletText(section: MarkdownSection): string[] {
  return parseBulletEntries(section).map((entry) => entry.raw);
}

function parseOutputContract(section: MarkdownSection) {
  const entries = parseYamlListSection(section);
  if (entries.length > 0) {
    return entries.map((entry, index) => {
      const data =
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? { ...entry, raw: JSON.stringify(entry), line: section.line + index + 1 }
          : { raw: String(entry), line: section.line + index + 1 };
      return outputContractEntrySchema.parse(data);
    });
  }
  return parseBulletEntries(section).map((entry) =>
    outputContractEntrySchema.parse(entry),
  );
}

function parseDefinitionOfDone(
  section: MarkdownSection,
  filePath?: string,
): Verifier[] {
  const parsed = parseYamlListSection(section, filePath);
  if (parsed.length === 0 && section.content.length > 0) {
    throw new DirectivesParseError(
      "DEFINITION OF DONE must be a YAML list of verifier objects",
      section.line + 1,
      1,
      filePath,
    );
  }

  return parsed.map((entry, index) => {
    const result = verifierSchema.safeParse(entry);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new DirectivesParseError(
        `invalid verifier at index ${index}: ${first?.message ?? "unknown error"}`,
        section.line + index + 1,
        1,
        filePath,
      );
    }
    return result.data;
  });
}

function parseYamlListSection(
  section: MarkdownSection,
  filePath?: string,
): unknown[] {
  if (section.content.trim() === "") return [];
  const lineCounter = new LineCounter();
  const document = parseDocument(section.content, { lineCounter });
  const error = document.errors[0];
  if (error) {
    const pos = error.linePos?.[0];
    throw new DirectivesParseError(
      error.message,
      section.line + (pos?.line ?? 1),
      pos?.col ?? 1,
      filePath,
    );
  }
  const parsed = document.toJSON();
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

function parseInitialDecomposition(section: MarkdownSection) {
  return parseBulletEntries(section).map((entry) => {
    const separator = entry.raw.indexOf(":");
    if (separator === -1) {
      return { id: entry.raw, text: entry.raw, line: entry.line };
    }
    return {
      id: entry.raw.slice(0, separator).trim(),
      text: entry.raw.slice(separator + 1).trim(),
      line: entry.line,
    };
  });
}

function zodToDirectivesError(
  error: z.ZodError,
  filePath?: string,
): DirectivesParseError {
  const first = error.issues[0];
  const path = first?.path.length ? first.path.join(".") : "document";
  return new DirectivesParseError(
    `invalid DIRECTIVES ${path}: ${first?.message ?? "unknown error"}`,
    1,
    1,
    filePath,
  );
}
