import { readJournal } from "./journal.js";
import type { JournalStep } from "./schema.js";
import { getCurrentStep } from "./journal.js";

export type JournalSnapshot =
  | {
      agent: string;
      current_step: string | null;
      status: JournalStep["status"] | null;
      progress: string;
      blocker: string;
      turns_used: number;
    }
  | {
      truncated: true;
      pointer: string;
      bytes: number;
    };

export async function snapshotJournal(
  journalPath: string,
  maxBytes = 400,
): Promise<JournalSnapshot> {
  const journal = await readJournal(journalPath);
  const current = getCurrentStep(journal);
  const snapshot = {
    agent: journal.agent,
    current_step: current ? `${current.id}: ${current.title}` : null,
    status: current?.status ?? null,
    progress: current?.progress ?? "none",
    blocker: current?.blocker ?? "none",
    turns_used: journal.turnsUsed,
  };

  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (bytes <= maxBytes) return snapshot;
  return { truncated: true, pointer: journalPath, bytes };
}
