import { constants } from "node:fs";
import { link, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDirectivesContent } from "../directives/parse.js";
import { fileExists, fsyncDir, fsyncFile, isNodeError } from "../fs/atomic.js";

export class DirectivesAlreadyExistsError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`DIRECTIVES.md already exists at ${filePath}`);
    this.name = "DirectivesAlreadyExistsError";
    this.filePath = filePath;
  }
}

export type WriteDirectivesResult = {
  path: string;
  extraSystemPrompt: string;
};

export async function writeDirectives(
  filePath: string,
  content: string,
): Promise<WriteDirectivesResult> {
  if (await fileExists(filePath)) {
    throw new DirectivesAlreadyExistsError(filePath);
  }

  parseDirectivesContent(content, filePath);

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${randomUUID()}`);

  await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
  await fsyncFile(tmp);

  try {
    await link(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new DirectivesAlreadyExistsError(filePath);
    }
    throw error;
  }

  await unlink(tmp);
  await fsyncDir(dir);

  return { path: filePath, extraSystemPrompt: buildExtraSystemPrompt(content) };
}

export async function writeDirectivesInWorkspace(
  workspaceDir: string,
  content: string,
): Promise<WriteDirectivesResult> {
  return writeDirectives(path.join(workspaceDir, "DIRECTIVES.md"), content);
}

export function buildExtraSystemPrompt(directivesContent: string): string {
  return [
    "## AGENT CONTRACT  [immutable, in system prompt cache; set once at spawn]",
    "",
    directivesContent.trimEnd(),
    "",
    "--- end contract ---",
  ].join("\n");
}

export async function assertDirectivesAbsent(filePath: string): Promise<void> {
  try {
    const handle = await open(filePath, constants.O_RDONLY);
    await handle.close();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new DirectivesAlreadyExistsError(filePath);
}
