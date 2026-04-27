import crypto from "node:crypto";
import type { AgentEvent, Verifier } from "../directives/schema.js";
import { appendEvent } from "../events/log.js";
import {
  recordVerifierRun,
  type VerifierRunRecord,
} from "./pass-registry.js";
import { verifyAllOf, verifyAnyOf } from "./types/composite.js";
import { verifyFileAbsent } from "./types/file-absent.js";
import { verifyFileExists } from "./types/file-exists.js";
import { verifyFsSizeUnder } from "./types/fs-size-under.js";
import { verifyGrepAbsent } from "./types/grep-absent.js";
import { verifyGrepPresent } from "./types/grep-present.js";
import { verifyHttpStatus } from "./types/http-status.js";
import { verifyJsonSchemaMatch } from "./types/json-schema-match.js";
import { verifyLlmJudge } from "./types/llm-judge.js";
import { verifyShellExitNonzero } from "./types/shell-exit-nonzero.js";
import { verifyShellExitZero } from "./types/shell-exit-zero.js";
import { verifyTestPasses } from "./types/test-passes.js";
import type { VerifierContext, VerifierResult } from "./types/common.js";

export type RunAllDoDResult = {
  allPass: boolean;
  results: Array<{ verifier: Verifier; result: VerifierResult }>;
};

export type VerifierRunContext = VerifierContext & {
  agent?: string;
  session?: string;
};

type FailureCounter = {
  signature: string;
  count: number;
};

const failureCounters = new Map<string, FailureCounter>();

export async function runVerifier(
  verifier: Verifier,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  switch (verifier.type) {
    case "file_exists":
      return verifyFileExists(verifier as Verifier & { type: "file_exists"; path: string }, ctx);
    case "file_absent":
      return verifyFileAbsent(verifier as Verifier & { type: "file_absent"; path: string }, ctx);
    case "shell_exit_zero":
      return verifyShellExitZero(
        verifier as Verifier & { type: "shell_exit_zero"; cmd: string; cwd?: string; timeout_s?: number },
        ctx,
      );
    case "shell_exit_nonzero":
      return verifyShellExitNonzero(
        verifier as Verifier & { type: "shell_exit_nonzero"; cmd: string; cwd?: string; timeout_s?: number },
        ctx,
      );
    case "http_status":
      return verifyHttpStatus(
        verifier as Verifier & {
          type: "http_status";
          url: string;
          method?: string;
          headers?: Record<string, string>;
          body_json?: unknown;
          status: number;
          expect_json?: unknown;
          timeout_s?: number;
        },
        ctx,
      );
    case "grep_present":
      return verifyGrepPresent(
        verifier as Verifier & { type: "grep_present"; path: string; pattern: string; flags?: string },
        ctx,
      );
    case "grep_absent":
      return verifyGrepAbsent(
        verifier as Verifier & { type: "grep_absent"; path: string; pattern: string; flags?: string },
        ctx,
      );
    case "test_passes":
      return verifyTestPasses(
        verifier as Verifier & { type: "test_passes"; cmd: string; timeout_s?: number },
        ctx,
      );
    case "json_schema_match":
      return verifyJsonSchemaMatch(
        verifier as Verifier & { type: "json_schema_match"; path?: string; cmd?: string; schema: unknown },
        ctx,
      );
    case "fs_size_under":
      return verifyFsSizeUnder(
        verifier as Verifier & { type: "fs_size_under"; path: string; max_bytes: number },
        ctx,
      );
    case "llm_judge":
      return verifyLlmJudge(
        verifier as Verifier & {
          type: "llm_judge";
          rubric_path?: string;
          rubric?: string;
          inputs: unknown[];
          min_score: number;
          judge_model?: string;
          seed?: number;
        },
        ctx,
      );
    case "all_of":
      return verifyAllOf(
        verifier as Verifier & { type: "all_of"; checks: Verifier[] },
        ctx,
        runVerifier,
      );
    case "any_of":
      return verifyAnyOf(
        verifier as Verifier & { type: "any_of"; checks: Verifier[] },
        ctx,
        runVerifier,
      );
  }
}

export async function runAllDoD(
  dod: Verifier[],
  ctx: VerifierContext,
): Promise<RunAllDoDResult> {
  const results: RunAllDoDResult["results"] = [];
  for (const verifier of dod) {
    results.push({ verifier, result: await runVerifier(verifier, ctx) });
  }
  return {
    allPass: results.every(({ result }) => result.pass),
    results,
  };
}

export async function runDoDForStep(
  stepId: string,
  dod: Verifier[],
  ctx: VerifierRunContext,
): Promise<RunAllDoDResult & { verifierRunId: string; dodHash: string }> {
  const verifierRunId = `vr-${crypto.randomUUID()}`;
  const ts = new Date().toISOString();
  const run = await runAllDoD(dod, ctx);
  const failures = run.results
    .filter(({ result }) => !result.pass)
    .map(({ verifier, result }) =>
      [
        `${verifier.type}: ${result.detail}`,
        result.evidence ? result.evidence.slice(0, 500) : "",
      ]
        .filter(Boolean)
        .join(" — "),
    );
  const dodHash = hashDoD(dod);

  const record: VerifierRunRecord = {
    agent: ctx.agent ?? "unknown",
    session: ctx.session,
    stepId,
    ts,
    allPass: run.allPass,
    verifierRunId,
    dodHash,
    failures,
  };
  recordVerifierRun(record);

  await appendEvent(ctx.workspaceDir, verifierRunEvent(record, run));
  if (!run.allPass) {
    await maybeEmitStuckWarning(ctx, stepId, failures);
  } else {
    failureCounters.delete(failureKey(ctx.agent ?? "unknown", stepId));
  }

  return { ...run, verifierRunId, dodHash };
}

export function hashDoD(dod: Verifier[]): string {
  return crypto.createHash("sha256").update(stableStringify(dod)).digest("hex");
}

export function clearVerifierFailureCountersForTests(): void {
  failureCounters.clear();
}

function verifierRunEvent(
  record: VerifierRunRecord,
  run: RunAllDoDResult,
): AgentEvent {
  return {
    event: "AGENT:VERIFIER_RUN",
    event_id: crypto.randomUUID(),
    ts: record.ts,
    agent: record.agent,
    session: record.session,
    step: record.stepId,
    verifier_run_id: record.verifierRunId,
    all_pass: record.allPass,
    failures: run.results
      .filter(({ result }) => !result.pass)
      .map(({ verifier, result }) => ({
        type: verifier.type,
        detail: result.detail,
        evidence: result.evidence,
      })),
  };
}

async function maybeEmitStuckWarning(
  ctx: VerifierRunContext,
  stepId: string,
  failures: string[],
): Promise<void> {
  const agent = ctx.agent ?? "unknown";
  const key = failureKey(agent, stepId);
  const signature = failures.join("\n");
  const current = failureCounters.get(key);
  const next =
    current?.signature === signature
      ? { signature, count: current.count + 1 }
      : { signature, count: 1 };
  failureCounters.set(key, next);
  if (next.count !== 3) return;

  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:STUCK_WARNING",
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent,
    session: ctx.session,
    heuristic: "3 consecutive verifier failures on same step",
    step: stepId,
    failure_signature: signature.slice(0, 400),
  });
}

function failureKey(agent: string, stepId: string): string {
  return `${agent}\u0000${stepId}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
