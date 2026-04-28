import type { JsonValue, Verifier } from "../../directives/schema.js";

export type MleBenchSpec = {
  submissionFile: string;
  submissionSchema: JsonValue;
  submissionCmd: string;
  metricCmd: string;
  metricThreshold: number;
  cwd?: string;
  timeoutSec?: number;
};

export function buildDoD(spec: MleBenchSpec): Verifier[] {
  return [
    {
      type: "file_exists",
      path: spec.submissionFile,
    },
    {
      type: "json_schema_match",
      path: spec.submissionFile,
      schema: spec.submissionSchema,
    },
    {
      type: "shell_exit_zero",
      cmd: spec.submissionCmd,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
    },
    {
      type: "shell_exit_zero",
      cmd: `${spec.metricCmd} | awk '{if ($1 >= ${spec.metricThreshold}) exit 0; else exit 1}'`,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.timeoutSec ? { timeout_s: spec.timeoutSec } : {}),
    },
  ];
}
