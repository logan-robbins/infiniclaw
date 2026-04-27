import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../events/log.js";
import { isNodeError } from "../fs/atomic.js";
import { writeDirectives } from "./write-directives.js";

export type SpawnChildOptions = {
  parentWorkspaceDir: string;
  childId: string;
  directivesContent: string;
  parentAgent?: string;
  parentSession?: string;
  inventorySourcePath?: string;
};

export type SpawnChildResult = {
  childWorkspaceDir: string;
  directivesPath: string;
  extraSystemPrompt: string;
};

export async function spawnChildDirectives(opts: SpawnChildOptions): Promise<SpawnChildResult> {
  const childWorkspaceDir = path.join(opts.parentWorkspaceDir, opts.childId);
  await mkdir(childWorkspaceDir, { recursive: true });

  await symlinkOnce("../.agent-events.jsonl", path.join(childWorkspaceDir, ".agent-events.jsonl"));

  if (opts.inventorySourcePath) {
    const rel = path.relative(childWorkspaceDir, opts.inventorySourcePath);
    await symlinkOnce(rel, path.join(childWorkspaceDir, "INVENTORY.md"));
  }

  const result = await writeDirectives(
    path.join(childWorkspaceDir, "DIRECTIVES.md"),
    opts.directivesContent,
  );

  await appendEvent(opts.parentWorkspaceDir, {
    event: "AGENT:SUBAGENT_SPAWNED",
    ts: new Date().toISOString(),
    agent: opts.parentAgent ?? "main",
    session: opts.parentSession,
    child: opts.childId,
    child_workspace: childWorkspaceDir,
  });

  return {
    childWorkspaceDir,
    directivesPath: result.path,
    extraSystemPrompt: result.extraSystemPrompt,
  };
}

async function symlinkOnce(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return;
    throw error;
  }
}
