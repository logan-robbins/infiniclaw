import type { Journal } from "./schema.js";
import { getCurrentStep, getNextStep } from "./journal.js";

export function buildLiveStateInjection(journal: Journal): string {
  const current = getCurrentStep(journal);
  const next = getNextStep(journal);
  const progress = current?.progress ?? "none";
  const blocker = current?.blocker ?? "none";
  const lastVerifier = journal.lastVerifierRun
    ? `${journal.lastVerifierRun} — failed: ${current?.lastVerifierFailures?.join("; ") || "none"}   (ok to attempt DONE)`
    : "none";

  return [
    "## LIVE STATE  [from JOURNAL.md, re-read every turn — survives compression]",
    "",
    `CURRENT STEP:   ${current ? `${current.id} — ${current.title}` : "none"}`,
    `PROGRESS:       ${progress}`,
    `BLOCKER:        ${blocker}`,
    `TURNS USED:     ${formatTurns(journal)}`,
    `LAST VERIFIER:  ${lastVerifier}`,
    `NEXT STEP:      ${next ? `${next.id} — ${next.title}` : "none"}`,
    "",
    "REMINDERS:",
    "  - Your contract (goal, I/O, DoD, constraints, PROTOCOL) is in your system",
    "    prompt — already visible above. Do not re-read DIRECTIVES.md per turn.",
    "  - To mark a step DONE, you must first call the verifier runner and have",
    "    every DoD criterion return PASS. The write layer enforces this.",
    "  - Before any new file, grep ../../INVENTORY.md for existing services.",
  ].join("\n");
}

function formatTurns(journal: Journal): string {
  const max = journal.turnBudget?.maxTurns;
  const warn = journal.turnBudget?.warningAt;
  const escalate = journal.turnBudget?.escalateAt;
  return `${journal.turnsUsed}/${max ?? "unknown"}   (warn ${warn ?? "unknown"}, escalate ${escalate ?? "unknown"})`;
}
