import type { Verifier } from "../../directives/schema.js";

export type ResearchWriteupSpec = {
  reportPath: string;
  topic: string;
  minScore?: number;
  judgeModel?: string;
  minWords?: number;
};

const RUBRIC = `
You are evaluating a research writeup. Score 1-10 on these dimensions:
1. Introduction (2pts): Clear problem statement and motivation.
2. Evidence (3pts): Claims are backed by concrete evidence, citations, or data.
3. Conclusion (2pts): Conclusions follow from the evidence; limitations acknowledged.
4. Citations (2pts): Sources cited; no fabricated references.
5. Structure (1pt): Readable, well-organized, free of filler.

Topic: {{topic}}

Return JSON: { "score": <0.0-10.0>, "rationale": "<concise evaluation>" }
`.trim();

export function buildDoD(spec: ResearchWriteupSpec): Verifier[] {
  const dod: Verifier[] = [
    {
      type: "file_exists",
      path: spec.reportPath,
    },
  ];

  if (spec.minWords) {
    dod.push({
      type: "shell_exit_zero",
      cmd: `wc -w < "${spec.reportPath}" | awk '{if ($1 >= ${spec.minWords}) exit 0; else exit 1}'`,
    });
  }

  dod.push({
    type: "llm_judge",
    rubric: RUBRIC.replace("{{topic}}", spec.topic),
    inputs: [{ path: spec.reportPath }],
    min_score: spec.minScore ?? 7.0,
    ...(spec.judgeModel ? { judge_model: spec.judgeModel } : {}),
  });

  return dod;
}
