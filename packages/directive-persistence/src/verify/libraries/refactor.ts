import type { Verifier } from "../../directives/schema.js";

export type RefactorSpec = {
  testCmd: string;
  fuzzCmd?: string;
  targetFiles: string[];
  cwd?: string;
  timeoutSec?: number;
};

export function buildDoD(spec: RefactorSpec): Verifier[] {
  const dod: Verifier[] = spec.targetFiles.map((f) => ({
    type: "file_exists" as const,
    path: f,
  }));

  dod.push({
    type: "shell_exit_zero",
    cmd: spec.testCmd,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
  });

  if (spec.fuzzCmd) {
    // Behavioral diff must be empty: the fuzz harness exits 0 only if no
    // observable difference exists between old and new implementations.
    dod.push({
      type: "shell_exit_zero",
      cmd: spec.fuzzCmd,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
    });
  }

  return dod;
}
