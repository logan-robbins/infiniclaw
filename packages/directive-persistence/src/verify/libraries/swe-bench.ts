import type { Verifier } from "../../directives/schema.js";

export type SweBenchSpec = {
  patchFile: string;
  testCmd: string;
  neighborTestCmd?: string;
  cwd?: string;
  timeoutSec?: number;
};

export function buildDoD(spec: SweBenchSpec): Verifier[] {
  const dod: Verifier[] = [
    {
      type: "file_exists",
      path: spec.patchFile,
    },
    {
      type: "shell_exit_zero",
      cmd: `git apply --check ${spec.patchFile}`,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
    },
    {
      type: "shell_exit_zero",
      cmd: spec.testCmd,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
    },
  ];

  if (spec.neighborTestCmd) {
    dod.push({
      type: "shell_exit_zero",
      cmd: spec.neighborTestCmd,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
    });
  }

  return dod;
}
