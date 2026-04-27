export type VerifierRunRecord = {
  agent: string;
  session?: string;
  stepId: string;
  ts: string;
  allPass: boolean;
  verifierRunId: string;
  dodHash: string;
  failures: string[];
};

const latestRuns = new Map<string, VerifierRunRecord>();

export function recordVerifierRun(record: VerifierRunRecord): void {
  latestRuns.set(key(record.agent, record.stepId), record);
}

export function getLatestVerifierRun(
  agent: string,
  stepId: string,
): VerifierRunRecord | undefined {
  return latestRuns.get(key(agent, stepId));
}

export function getLatestPass(
  agent: string,
  stepId: string,
): VerifierRunRecord | undefined {
  const record = getLatestVerifierRun(agent, stepId);
  return record?.allPass ? record : undefined;
}

export function clearVerifierRun(agent: string, stepId: string): void {
  latestRuns.delete(key(agent, stepId));
}

export function clearVerifierRegistryForTests(): void {
  latestRuns.clear();
}

function key(agent: string, stepId: string): string {
  return `${agent}\u0000${stepId}`;
}

