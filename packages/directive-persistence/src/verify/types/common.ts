import path from "node:path";

export type VerifierPass = {
  pass: true;
  detail?: string;
  evidence?: string;
};

export type VerifierFail = {
  pass: false;
  detail: string;
  evidence?: string;
};

export type VerifierResult = VerifierPass | VerifierFail;

export type LlmJudgeInput = {
  rubric_path?: string;
  rubric?: string;
  inputs: unknown[];
  min_score: number;
  judge_model?: string;
  seed?: number;
};

export type LlmJudgeResult = {
  score: number;
  rationale: string;
};

export type VerifierContext = {
  workspaceDir: string;
  llmJudge?: (
    input: LlmJudgeInput,
    ctx: VerifierContext,
  ) => Promise<LlmJudgeResult> | LlmJudgeResult;
};

export function resolveWorkspacePath(
  workspaceDir: string,
  candidate: string,
): string {
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workspaceDir, candidate);
}

export function evidenceFromOutput(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return combined.slice(0, 4000);
}

