import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseDirectives } from "../directives/parse.js";
import { fileExists } from "../fs/atomic.js";
import { getPassByRunId } from "../verify/pass-registry.js";
import { runAllDoD, type VerifierRunContext } from "../verify/runner.js";

export class TaskCompleteValidationError extends Error {
  readonly reason: string;
  readonly details: string;
  constructor(reason: string, details: string) {
    super(`Task complete validation failed: ${reason} — ${details}`);
    this.name = "TaskCompleteValidationError";
    this.reason = reason;
    this.details = details;
  }
}

export class TaskBlockedValidationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Task blocked report invalid: ${reason}`);
    this.name = "TaskBlockedValidationError";
    this.reason = reason;
  }
}

export const taskCompleteOutputSchema = z.object({
  kind: z.enum(["file", "service", "artifact"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u, "must be 64-char hex"),
  interface_summary: z.string().max(200).optional(),
});

export const dodEvidenceSchema = z.object({
  criterion_index: z.number().int().nonnegative(),
  verifier_run_id: z.string().min(1),
  result: z.literal("PASS"),
});

export const taskCompleteReportSchema = z.object({
  outputs: z.array(taskCompleteOutputSchema),
  dod_evidence: z.array(dodEvidenceSchema),
  service_card_proposal: z.string().nullable(),
});

export const taskBlockedReportSchema = z.object({
  classification: z.enum([
    "contract-dispute",
    "input-missing",
    "infra-issue",
    "implementation-hard",
  ]),
  step_id: z.string().min(1),
  summary: z.string().max(200),
  detail: z.string().min(1),
  proposed_remediation: z.string().nullable(),
});

export type TaskCompleteReport = z.infer<typeof taskCompleteReportSchema>;
export type TaskBlockedReport = z.infer<typeof taskBlockedReportSchema>;

export async function validateTaskComplete(opts: {
  report: TaskCompleteReport;
  agent: string;
  directivesPath: string;
  workspaceDir: string;
}): Promise<void> {
  const { report, agent, directivesPath, workspaceDir } = opts;

  const parsed = taskCompleteReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new TaskCompleteValidationError("schema_invalid", parsed.error.message);
  }

  const directives = await parseDirectives(directivesPath);
  const dod = directives.definitionOfDone;

  for (let i = 0; i < dod.length; i++) {
    const evidence = report.dod_evidence.find((e) => e.criterion_index === i);
    if (!evidence) {
      throw new TaskCompleteValidationError(
        `missing_evidence_for_criterion_${i}`,
        `No dod_evidence entry for criterion index ${i}`,
      );
    }
    const pass = getPassByRunId(evidence.verifier_run_id);
    if (!pass || pass.agent !== agent) {
      throw new TaskCompleteValidationError(
        `missing_verifier_run_id_for_criterion_${i}`,
        `verifier_run_id ${evidence.verifier_run_id} not found in pass registry for agent ${agent}`,
      );
    }
  }

  for (const output of report.outputs) {
    const filePath = path.isAbsolute(output.path)
      ? output.path
      : path.join(workspaceDir, output.path);
    if (!(await fileExists(filePath))) {
      throw new TaskCompleteValidationError(
        "output_file_missing",
        `Output file not found: ${output.path}`,
      );
    }
    const content = await readFile(filePath);
    const actual = crypto.createHash("sha256").update(content).digest("hex");
    if (actual !== output.sha256) {
      throw new TaskCompleteValidationError(
        "sha_mismatch_for_output",
        `SHA256 mismatch for ${output.path}: expected ${output.sha256}, got ${actual}`,
      );
    }
  }
}

export type ReVerifyFailure = {
  criterionIndex: number;
  detail: string;
  evidence?: string;
};

export async function reVerifyChildClaim(opts: {
  childDirectivesPath: string;
  ctx: VerifierRunContext;
}): Promise<{ allPass: boolean; failures: ReVerifyFailure[] }> {
  const directives = await parseDirectives(opts.childDirectivesPath);
  const dod = directives.definitionOfDone;
  const run = await runAllDoD(dod, opts.ctx);
  const failures: ReVerifyFailure[] = run.results
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => !r.result.pass)
    .map(({ i, r }) => ({
      criterionIndex: i,
      detail: `${dod[i]!.type}: ${r.result.detail}`,
      evidence: r.result.evidence,
    }));
  return { allPass: run.allPass, failures };
}
