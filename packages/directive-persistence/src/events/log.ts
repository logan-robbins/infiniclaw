import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { eventSchema, type AgentEvent } from "../directives/schema.js";

const SNAPSHOT_LIMIT_BYTES = 400;

export async function appendEvent(
  workspaceDir: string,
  event: AgentEvent,
): Promise<void> {
  const normalized = capSnapshot(event);
  eventSchema.parse(normalized);
  const logPath = path.join(workspaceDir, ".agent-events.jsonl");
  const handle = await open(
    logPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o644,
  );
  try {
    await handle.write(`${JSON.stringify(normalized)}\n`, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function capSnapshot(event: AgentEvent): AgentEvent {
  const snapshot = event.snapshot;
  if (snapshot === undefined) return event;

  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (bytes <= SNAPSHOT_LIMIT_BYTES) return event;

  return {
    ...event,
    snapshot: {
      truncated: true,
      bytes,
      max_bytes: SNAPSHOT_LIMIT_BYTES,
    },
  };
}
