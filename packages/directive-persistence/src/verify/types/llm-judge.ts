import { readFile } from "node:fs/promises";
import type { Verifier } from "../../directives/schema.js";
import {
  resolveWorkspacePath,
  type LlmJudgeInput,
  type VerifierContext,
  type VerifierResult,
} from "./common.js";

export async function verifyLlmJudge(
  verifier: Verifier & { type: "llm_judge"; rubric_path?: string; rubric?: string; inputs: unknown[]; min_score: number; judge_model?: string; seed?: number },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  if (!ctx.llmJudge) {
    return {
      pass: false,
      detail: "llm_judge verifier requires ctx.llmJudge provider",
    };
  }

  const input: LlmJudgeInput = {
    rubric_path: verifier.rubric_path,
    rubric: verifier.rubric ?? (await readRubricPath(verifier, ctx)),
    inputs: verifier.inputs,
    min_score: verifier.min_score,
    judge_model: verifier.judge_model,
    seed: verifier.seed,
  };
  const result = await ctx.llmJudge(input, ctx);
  if (result.score >= verifier.min_score) {
    return {
      pass: true,
      detail: `llm_judge score ${result.score} >= ${verifier.min_score}`,
      evidence: result.rationale,
    };
  }
  return {
    pass: false,
    detail: `llm_judge score ${result.score} < ${verifier.min_score}`,
    evidence: result.rationale,
  };
}

async function readRubricPath(
  verifier: Verifier & { type: "llm_judge"; rubric_path?: string; rubric?: string; inputs: unknown[]; min_score: number; judge_model?: string; seed?: number },
  ctx: VerifierContext,
): Promise<string | undefined> {
  if (!verifier.rubric_path) return undefined;
  return readFile(resolveWorkspacePath(ctx.workspaceDir, verifier.rubric_path), "utf8");
}

