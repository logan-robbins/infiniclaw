// Analyzes a stream of agent events and returns STUCK_WARNING payloads for any
// agent that matches the § 12.1 heuristics.

export type AgentEventRecord = Record<string, unknown> & {
  event: string;
  agent?: string;
  ts?: string;
};

export type StuckWarning = {
  event: "AGENT:STUCK_WARNING";
  agent: string;
  heuristic: string;
  step?: string;
  detail: string;
};

export function detectStuck(events: AgentEventRecord[]): StuckWarning[] {
  const warnings: StuckWarning[] = [];

  // --- heuristic 1: compression stall ---
  // ≥3 COMPRESSION_EVENTs at the same step_at_time for the same agent with no
  // STEP_COMPLETE in between.
  const compressionRuns = new Map<string, { step: string; count: number }>();
  for (const ev of events) {
    if (ev.event === "AGENT:COMPRESSION_EVENT") {
      const agent = String(ev.agent ?? "");
      const step = String(ev.step_at_time ?? "");
      const key = `${agent}\u0000${step}`;
      const current = compressionRuns.get(key);
      compressionRuns.set(key, { step, count: (current?.count ?? 0) + 1 });
    } else if (ev.event === "AGENT:STEP_COMPLETE") {
      const agent = String(ev.agent ?? "");
      for (const k of compressionRuns.keys()) {
        if (k.startsWith(`${agent}\u0000`)) compressionRuns.delete(k);
      }
    }
  }
  for (const [key, { step, count }] of compressionRuns) {
    if (count >= 3) {
      const agent = key.split("\u0000")[0]!;
      warnings.push({
        event: "AGENT:STUCK_WARNING",
        agent,
        heuristic: "3+ compressions at same step with no step advance",
        step,
        detail: `${count} compressions at step "${step}"`,
      });
    }
  }

  // --- heuristic 2: verifier thrash ---
  // ≥3 consecutive VERIFIER_RUN failures on the same step with identical failure signatures.
  type ThrashState = { failures: string[]; count: number };
  const verifierThrash = new Map<string, ThrashState>();
  for (const ev of events) {
    if (ev.event !== "AGENT:VERIFIER_RUN") continue;
    const agent = String(ev.agent ?? "");
    const step = String(ev.step ?? "");
    const allPass = Boolean(ev.all_pass);
    const key = `${agent}\u0000${step}`;
    if (allPass) {
      verifierThrash.delete(key);
      continue;
    }
    const failureList = Array.isArray(ev.failures)
      ? (ev.failures as unknown[]).map((f) =>
          typeof f === "object" && f !== null
            ? String((f as Record<string, unknown>).detail ?? "")
            : String(f),
        )
      : [];
    const sig = failureList.join("|");
    const current = verifierThrash.get(key);
    if (current && current.failures.join("|") === sig) {
      verifierThrash.set(key, { failures: failureList, count: current.count + 1 });
    } else {
      verifierThrash.set(key, { failures: failureList, count: 1 });
    }
  }
  for (const [key, { failures, count }] of verifierThrash) {
    if (count >= 3) {
      const [agent, step] = key.split("\u0000") as [string, string];
      warnings.push({
        event: "AGENT:STUCK_WARNING",
        agent,
        heuristic: "3 consecutive verifier failures on same step",
        step,
        detail: `failure signature: ${failures.slice(0, 3).join("; ")}`,
      });
    }
  }

  // --- heuristic 3: budget overshoot ---
  // Find agents whose last BUDGET_EXCEEDED event is present.
  const budgetExceeded = new Set<string>();
  for (const ev of events) {
    if (ev.event === "AGENT:BUDGET_EXCEEDED") budgetExceeded.add(String(ev.agent ?? ""));
  }
  for (const agent of budgetExceeded) {
    warnings.push({
      event: "AGENT:STUCK_WARNING",
      agent,
      heuristic: "budget overshoot",
      detail: "turns_used exceeded turn_budget",
    });
  }

  return warnings;
}
