import type { Verifier } from "../../directives/schema.js";

export type HcastGeneralSpec = {
  taskDescription: string;
  expectedOutputPath: string;
  minScore?: number;
  judgeModel?: string;
};

const DEFAULT_RUBRIC = `
Score 1-10 on the following dimensions (weight equally):
1. Correctness: Does the output correctly address the task described?
2. Completeness: Are all required parts of the task addressed?
3. Clarity: Is the output clear and well-structured?
4. Reasoning: Is the reasoning sound and well-supported?

Task: {{taskDescription}}

Return a JSON object: { "score": <0.0-10.0>, "rationale": "<one paragraph>" }
`.trim();

export function buildDoD(spec: HcastGeneralSpec): Verifier[] {
  return [
    {
      type: "file_exists",
      path: spec.expectedOutputPath,
    },
    {
      type: "llm_judge",
      rubric: DEFAULT_RUBRIC.replace("{{taskDescription}}", spec.taskDescription),
      inputs: [{ path: spec.expectedOutputPath }],
      min_score: spec.minScore ?? 7.0,
      ...(spec.judgeModel ? { judge_model: spec.judgeModel } : {}),
    },
  ];
}
