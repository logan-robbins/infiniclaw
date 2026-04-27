import path from "node:path";
import { parseDirectives } from "../directives/parse.js";
import { readJournal, writeParsedJournalAtomic } from "../directives/journal.js";
import type { Journal, JournalStepStatus } from "../directives/schema.js";
import { appendEvent } from "../events/log.js";
import { fileExists } from "../fs/atomic.js";
import { getLatestPass } from "../verify/pass-registry.js";
import { hashDoD } from "../verify/runner.js";

export type JournalEdit = {
  step_id: string;
  restore_status: JournalStepStatus;
};

export type StackTransition = {
  step_id: string;
  from: JournalStepStatus;
  to: JournalStepStatus;
};

// Module-level state — one entry per active session.
const turnStartSnapshots = new Map<string, Journal | null>();
const pendingNudges = new Map<string, string[]>();
const turnCounters = new Map<string, number>();

export function capturePreTurnSnapshot(sessionKey: string, journal: Journal | null): void {
  turnCounters.set(sessionKey, (turnCounters.get(sessionKey) ?? 0) + 1);
  turnStartSnapshots.set(sessionKey, journal);
}

export function currentTurnForSession(sessionKey: string): number {
  return turnCounters.get(sessionKey) ?? 0;
}

export function drainNudges(sessionKey: string): string[] {
  const msgs = pendingNudges.get(sessionKey) ?? [];
  pendingNudges.delete(sessionKey);
  return msgs;
}

export function diffTaskStack(
  before: Journal | null | undefined,
  after: Journal,
): StackTransition[] {
  if (!before) return [];
  const beforeMap = new Map(before.taskStack.map((s) => [s.id, s.status]));
  return after.taskStack
    .filter((step) => {
      const prev = beforeMap.get(step.id);
      return prev !== undefined && prev !== "DONE" && step.status === "DONE";
    })
    .map((step) => ({
      step_id: step.id,
      from: beforeMap.get(step.id)!,
      to: "DONE" as const,
    }));
}

export async function applyEditsAtomic(
  journalPath: string,
  edits: JournalEdit[],
): Promise<void> {
  const journal = await readJournal(journalPath);
  for (const edit of edits) {
    const step = journal.taskStack.find((s) => s.id === edit.step_id);
    if (step) {
      step.status = edit.restore_status;
      step.completed = undefined;
      step.verifierRunId = undefined;
    }
  }
  await writeParsedJournalAtomic(journalPath, journal);
}

function pushNextTurnNudge(sessionKey: string, edits: JournalEdit[], reasons: string[]): void {
  const msgs = edits.map((edit, i) => {
    const reason = reasons[i] ?? "no-verifier-run";
    return (
      `SYSTEM NOTICE: Step "${edit.step_id}" was automatically reverted from DONE to ` +
      `${edit.restore_status} (reason: ${reason}). ` +
      `You must call verifier.run("${edit.step_id}") and receive allPass=true ` +
      `in the same turn before writing status: DONE.`
    );
  });
  const existing = pendingNudges.get(sessionKey) ?? [];
  pendingNudges.set(sessionKey, [...existing, ...msgs]);
}

export async function runAfterTurn(opts: {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
}): Promise<void> {
  const { sessionKey, agentId, workspaceDir } = opts;
  const journalPath = path.join(workspaceDir, "JOURNAL.md");
  if (!(await fileExists(journalPath))) return;

  const before = turnStartSnapshots.get(sessionKey);
  const after = await readJournal(journalPath);
  const transitions = diffTaskStack(before, after);
  if (transitions.length === 0) return;

  const directivesPath = path.join(workspaceDir, "DIRECTIVES.md");
  let currentDodHash: string | null = null;
  if (await fileExists(directivesPath)) {
    const directives = await parseDirectives(directivesPath);
    currentDodHash = hashDoD(directives.definitionOfDone);
  }

  const revertEdits: JournalEdit[] = [];
  const revertReasons: string[] = [];
  const turn = currentTurnForSession(sessionKey);

  for (const t of transitions) {
    if (t.to !== "DONE") continue;
    const pass = getLatestPass(agentId, t.step_id);

    let reason: string;
    if (!pass) {
      reason = "no-verifier-run";
    } else if (pass.turnNo !== undefined && pass.turnNo !== turn) {
      reason = "stale-verifier-run";
    } else if (currentDodHash !== null && pass.dodHash !== currentDodHash) {
      reason = "dod-hash-mismatch";
    } else {
      continue;
    }

    revertEdits.push({ step_id: t.step_id, restore_status: t.from });
    revertReasons.push(reason);

    await appendEvent(workspaceDir, {
      event: "AGENT:JOURNAL_DONE_REVERTED",
      ts: new Date().toISOString(),
      agent: agentId,
      step_id: t.step_id,
      reason,
    });
  }

  if (revertEdits.length > 0) {
    await applyEditsAtomic(journalPath, revertEdits);
    pushNextTurnNudge(sessionKey, revertEdits, revertReasons);
  }
}

export function clearDoneRevertStateForTests(): void {
  turnStartSnapshots.clear();
  pendingNudges.clear();
  turnCounters.clear();
}
