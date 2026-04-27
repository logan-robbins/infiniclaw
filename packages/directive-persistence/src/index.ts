import crypto from "node:crypto";
import path from "node:path";
import { readJournal } from "./directives/journal.js";
import { buildLiveStateInjection } from "./directives/inject.js";
import { snapshotJournal } from "./directives/snapshot.js";
import { appendEvent } from "./events/log.js";
import { fileExists } from "./fs/atomic.js";

export const PLUGIN_NAME = "directive-persistence";
export const PLUGIN_VERSION = "0.2.0-phase2";

export type PluginHookAgentContext = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  messageProvider?: string;
};

export type BeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

export type PluginSdk = {
  registerHook?: (name: string, handler: (...args: any[]) => unknown) => void;
  on?: (name: string, handler: (...args: any[]) => unknown) => void;
};

type BeforeCompactionMetrics = {
  messageCount: number;
  tokenCount?: number;
  sessionFile?: string;
};

type AfterCompactionMetrics = {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  sessionFile: string;
};

export function register(sdk?: PluginSdk): void {
  if (!sdk) return;
  const on = sdk.on ?? sdk.registerHook;
  if (!on) return;

  on("before_prompt_build", beforePromptBuild);
  on("before_compaction", beforeCompaction);
  on("after_compaction", afterCompaction);
}

export async function beforePromptBuild(
  _event: unknown,
  ctx: PluginHookAgentContext,
): Promise<BeforePromptBuildResult> {
  const journalPath = path.join(ctx.workspaceDir, "JOURNAL.md");
  if (!(await fileExists(journalPath))) return {};

  const journal = await readJournal(journalPath);
  return { prependSystemContext: buildLiveStateInjection(journal) };
}

export async function beforeCompaction(
  metrics: BeforeCompactionMetrics,
  ctx: PluginHookAgentContext,
): Promise<void> {
  const journalPath = path.join(ctx.workspaceDir, "JOURNAL.md");
  if (!(await fileExists(journalPath))) return;

  const snapshot = await snapshotJournal(journalPath).catch(() => null);
  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:PRE_COMPRESSION_SNAPSHOT",
    ts: new Date().toISOString(),
    agent: ctx.agentId,
    session: ctx.sessionKey,
    snapshot,
    msgs_before: metrics.messageCount,
    tokens_before: metrics.tokenCount,
  });
}

export async function afterCompaction(
  metrics: AfterCompactionMetrics,
  ctx: PluginHookAgentContext,
): Promise<void> {
  const journalPath = path.join(ctx.workspaceDir, "JOURNAL.md");
  if (!(await fileExists(journalPath))) return;

  const step = await readJournal(journalPath)
    .then((journal) => {
      const current = journal.taskStack.find((item) => item.status === "IN_PROGRESS");
      return current ? `${current.id}: ${current.title}` : "unknown";
    })
    .catch(() => "unknown");

  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:COMPRESSION_EVENT",
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent: ctx.agentId,
    session: ctx.sessionKey,
    msgs_before: metrics.messageCount + metrics.compactedCount,
    msgs_after: metrics.messageCount,
    compacted_count: metrics.compactedCount,
    tokens_after: metrics.tokenCount,
    step_at_time: step,
    session_file: metrics.sessionFile,
  });
}

export default {
  id: PLUGIN_NAME,
  name: "Directive Persistence",
  version: PLUGIN_VERSION,
  description: "DIRECTIVES/JOURNAL split and cache-aware live-state injection for long-horizon agents.",
  register,
};
