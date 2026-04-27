import type { Verifier } from "../../directives/schema.js";

export type HcastSweSpec = {
  testCmd: string;
  targetFiles: string[];
  lintCmd?: string;
  cwd?: string;
  timeoutSec?: number;
};

export function buildDoD(spec: HcastSweSpec): Verifier[] {
  const dod: Verifier[] = spec.targetFiles.map((f) => ({
    type: "file_exists" as const,
    path: f,
  }));

  if (spec.lintCmd) {
    dod.push({
      type: "shell_exit_zero",
      cmd: spec.lintCmd,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
    });
  }

  dod.push({
    type: "shell_exit_zero",
    cmd: spec.testCmd,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
  });

  return dod;
}
