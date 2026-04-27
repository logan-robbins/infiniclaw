#!/usr/bin/env node
// Usage: agent-report <path/to/.agent-events.jsonl>
// Prints a per-agent summary: compression count, step histogram, budget status.

import { readFileSync } from "node:fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: agent-report <path/to/.agent-events.jsonl>");
  process.exit(1);
}

type EventRecord = Record<string, unknown> & { event: string; agent?: string };

const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
const events: EventRecord[] = lines.map((l) => JSON.parse(l) as EventRecord);

type AgentStats = {
  compressions: number;
  stepCompletions: number;
  stepHistogram: Map<string, number>;
  verifierRuns: number;
  verifierPasses: number;
  turnsUsed?: number;
  turnBudget?: number;
  budgetWarnings: number;
  budgetExceeded: boolean;
  blocked: number;
  stuckWarnings: number;
  doneReverts: number;
};

const stats = new Map<string, AgentStats>();

function getStats(agent: string): AgentStats {
  if (!stats.has(agent)) {
    stats.set(agent, {
      compressions: 0,
      stepCompletions: 0,
      stepHistogram: new Map(),
      verifierRuns: 0,
      verifierPasses: 0,
      budgetWarnings: 0,
      budgetExceeded: false,
      blocked: 0,
      stuckWarnings: 0,
      doneReverts: 0,
    });
  }
  return stats.get(agent)!;
}

for (const ev of events) {
  const agent = String(ev.agent ?? "(unknown)");
  const s = getStats(agent);

  switch (ev.event) {
    case "AGENT:COMPRESSION_EVENT":
      s.compressions++;
      if (ev.step_at_time) {
        const step = String(ev.step_at_time);
        s.stepHistogram.set(step, (s.stepHistogram.get(step) ?? 0) + 1);
      }
      break;
    case "AGENT:STEP_COMPLETE":
      s.stepCompletions++;
      break;
    case "AGENT:VERIFIER_RUN":
      s.verifierRuns++;
      if (ev.all_pass) s.verifierPasses++;
      break;
    case "AGENT:BUDGET_WARNING":
      s.budgetWarnings++;
      if (ev.turns_used !== undefined) s.turnsUsed = Number(ev.turns_used);
      if (ev.turn_budget !== undefined) s.turnBudget = Number(ev.turn_budget);
      break;
    case "AGENT:BUDGET_EXCEEDED":
      s.budgetExceeded = true;
      if (ev.turns_used !== undefined) s.turnsUsed = Number(ev.turns_used);
      if (ev.turn_budget !== undefined) s.turnBudget = Number(ev.turn_budget);
      break;
    case "AGENT:BLOCKED":
      s.blocked++;
      break;
    case "AGENT:STUCK_WARNING":
      s.stuckWarnings++;
      break;
    case "AGENT:JOURNAL_DONE_REVERTED":
      s.doneReverts++;
      break;
  }
}

for (const [agent, s] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`\n── ${agent}`);
  console.log(`   compressions   : ${s.compressions}`);
  console.log(`   step completes : ${s.stepCompletions}`);
  console.log(
    `   verifier runs  : ${s.verifierRuns} (${s.verifierPasses} pass, ${s.verifierRuns - s.verifierPasses} fail)`,
  );
  if (s.turnsUsed !== undefined || s.turnBudget !== undefined) {
    const pct =
      s.turnsUsed !== undefined && s.turnBudget !== undefined
        ? ` (${Math.round((s.turnsUsed / s.turnBudget) * 100)}%)`
        : "";
    console.log(`   budget         : ${s.turnsUsed ?? "?"}/${s.turnBudget ?? "?"}${pct}`);
  }
  if (s.budgetExceeded) console.log(`   ⚠ BUDGET EXCEEDED`);
  if (s.stuckWarnings > 0) console.log(`   ⚠ stuck warnings: ${s.stuckWarnings}`);
  if (s.doneReverts > 0) console.log(`   ⚠ DONE reverts  : ${s.doneReverts}`);
  if (s.blocked > 0) console.log(`   blocked events  : ${s.blocked}`);
  if (s.stepHistogram.size > 0) {
    console.log(`   compression histogram by step:`);
    for (const [step, count] of [...s.stepHistogram.entries()].sort(([, a], [, b]) => b - a)) {
      console.log(`     ${count.toString().padStart(3)}  ${step}`);
    }
  }
}
console.log();
