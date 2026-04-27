import { z } from "zod";

export const verifierTypeSchema = z.enum([
  "file_exists",
  "file_absent",
  "shell_exit_zero",
  "shell_exit_nonzero",
  "http_status",
  "grep_present",
  "grep_absent",
  "test_passes",
  "json_schema_match",
  "fs_size_under",
  "llm_judge",
  "all_of",
  "any_of",
]);

type RecursiveVerifierInput = z.infer<typeof baseVerifierSchema> & {
  checks?: RecursiveVerifierInput[];
};

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const baseVerifierSchema = z.object({
  type: verifierTypeSchema,
});

export const verifierSchema: z.ZodType<RecursiveVerifierInput> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("file_exists"), path: z.string().min(1) }),
    z.object({ type: z.literal("file_absent"), path: z.string().min(1) }),
    z.object({
      type: z.literal("shell_exit_zero"),
      cmd: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeout_s: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("shell_exit_nonzero"),
      cmd: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeout_s: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("http_status"),
      url: z.string().min(1),
      method: z.string().min(1).optional(),
      headers: z.record(z.string()).optional(),
      body_json: jsonValueSchema.optional(),
      status: z.number().int(),
      expect_json: jsonValueSchema.optional(),
      timeout_s: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("grep_present"),
      path: z.string().min(1),
      pattern: z.string().min(1),
      flags: z.string().optional(),
    }),
    z.object({
      type: z.literal("grep_absent"),
      path: z.string().min(1),
      pattern: z.string().min(1),
      flags: z.string().optional(),
    }),
    z.object({
      type: z.literal("test_passes"),
      cmd: z.string().min(1),
      timeout_s: z.number().int().positive().optional(),
    }),
    z
      .object({
        type: z.literal("json_schema_match"),
        path: z.string().min(1).optional(),
        cmd: z.string().min(1).optional(),
        schema: jsonValueSchema,
      })
      .refine((value) => value.path || value.cmd, {
        message: "json_schema_match requires path or cmd",
      }),
    z.object({
      type: z.literal("fs_size_under"),
      path: z.string().min(1),
      max_bytes: z.number().int().nonnegative(),
    }),
    z
      .object({
        type: z.literal("llm_judge"),
        rubric_path: z.string().min(1).optional(),
        rubric: z.string().min(1).optional(),
        inputs: z.array(jsonValueSchema),
        min_score: z.number(),
        judge_model: z.string().min(1).optional(),
        seed: z.number().int().optional(),
      })
      .refine((value) => value.rubric_path || value.rubric, {
        message: "llm_judge requires rubric_path or rubric",
      }),
    z.object({
      type: z.literal("all_of"),
      checks: z.array(verifierSchema).min(1),
    }),
    z.object({
      type: z.literal("any_of"),
      checks: z.array(verifierSchema).min(1),
    }),
  ]),
);

export const turnBudgetSchema = z.object({
  maxTurns: z.number().int().nonnegative(),
  warningAt: z.number().int().nonnegative().optional(),
  escalateAt: z.number().int().nonnegative().optional(),
});

export const contractEntrySchema = z.object({
  raw: z.string().min(1),
  line: z.number().int().positive(),
});

export const outputContractEntrySchema = contractEntrySchema.extend({
  kind: z.string().optional(),
  path: z.string().optional(),
  exports: z.array(z.string()).optional(),
  interface: z.string().optional(),
});

export const initialStepSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  line: z.number().int().positive(),
});

export const directivesSchema = z.object({
  schemaVersion: z.number().int().positive(),
  agent: z.string().min(1),
  parent: z.string().nullable(),
  workspace: z.string().min(1),
  spawned: z.string().min(1),
  journal: z.string().min(1),
  goal: z.string().min(1),
  inputContract: z.array(contractEntrySchema),
  outputContract: z.array(outputContractEntrySchema),
  definitionOfDone: z.array(verifierSchema),
  constraints: z.array(z.string()),
  turnBudget: turnBudgetSchema,
  initialDecomposition: z.array(initialStepSchema),
  protocol: z.string().min(1),
  raw: z.string(),
});

export const journalStepStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "DONE",
  "BLOCKED",
]);

export const journalStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: journalStepStatusSchema,
  line: z.number().int().positive(),
  started: z.string().nullable().optional(),
  completed: z.string().nullable().optional(),
  progress: z.string().nullable().optional(),
  blocker: z.string().nullable().optional(),
  turnsInStep: z.number().int().nonnegative().optional(),
  verifierRunId: z.string().nullable().optional(),
  verifiedOutputs: z.array(z.string()).optional(),
  blackBox: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
  expectedOutput: z.string().optional(),
  lastVerifierFailures: z.array(z.string()).optional(),
  rawFields: z.record(z.unknown()).optional(),
});

export const journalSchema = z.object({
  schemaVersion: z.number().int().positive(),
  agent: z.string().min(1),
  lastUpdated: z.string().min(1),
  turnsUsed: z.number().int().nonnegative(),
  lastVerifierRun: z.string().nullable(),
  turnBudget: turnBudgetSchema.partial().optional(),
  taskStack: z.array(journalStepSchema),
  workingNotes: z.array(z.string()),
  subAgents: z.string(),
  completionReport: z.string(),
  raw: z.string(),
});

export const planSchema = z.object({
  title: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  created: z.string().min(1),
  lastReplanned: z.string().min(1),
  status: z.enum(["ACTIVE", "COMPLETE", "ABANDONED"]),
  owner: z.string().min(1),
  turnBudgetTotal: z.number().int().nonnegative(),
  costBudgetUsd: z.number().nonnegative(),
  goal: z.string().min(1),
  highLevelDefinitionOfDone: z.array(verifierSchema),
  stages: z.array(
    z.object({
      ordinal: z.number().int().positive(),
      id: z.string().min(1),
      status: z.enum(["PENDING", "ACTIVE", "SEALED", "ABANDONED"]),
      depends: z.array(z.string()),
      seal: z.string().optional(),
      out: z.string().optional(),
    }),
  ),
  sealedOutputsRegistry: z.array(z.string()),
  globalConstraints: z.array(z.string()),
  notes: z.string(),
  raw: z.string(),
});

export const stageDependencySchema = z.object({
  service: z.string().min(1),
  requiredSections: z.array(z.string()).optional(),
});

export const stageOutputSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  exports: z.array(z.string()).optional(),
  interface: z.string().optional(),
});

export const stageSubTaskSchema = z.object({
  key: z.string().min(1),
  id: z.string().min(1),
  goal: z.string().min(1),
  inputContract: z.array(contractEntrySchema),
  outputContract: z.array(contractEntrySchema),
  canStart: z.string().min(1).optional(),
  turnBudget: z.number().int().nonnegative().optional(),
  preset: z.string().min(1).optional(),
});

export const stageSchema = z.object({
  title: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  status: z.enum(["PENDING", "ACTIVE", "SEALED", "ABANDONED"]),
  created: z.string().min(1),
  activated: z.string().nullable(),
  sealed: z.string().nullable(),
  turnBudget: z.number().int().nonnegative(),
  dependsOn: z.array(stageDependencySchema),
  outputContract: z.array(stageOutputSchema),
  definitionOfDone: z.array(verifierSchema),
  subTasks: z.array(stageSubTaskSchema),
  contextForSubAgents: z.array(z.string()),
  executionLog: z.array(z.string()),
  sealedSummary: z.string(),
  raw: z.string(),
});

export const inventoryEntrySchema = z.object({
  name: z.string().min(1),
  stage: z.string().min(1),
  path: z.string().min(1),
  summary: z.string().min(1),
});

export const inventorySchema = z.object({
  schemaVersion: z.number().int().positive(),
  entries: z.array(inventoryEntrySchema),
});

export const eventSchema = z
  .object({
    event: z.string().min(1),
    ts: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
  })
  .and(z.record(z.unknown()));

export type Verifier = z.infer<typeof verifierSchema>;
export type Directives = z.infer<typeof directivesSchema>;
export type Journal = z.infer<typeof journalSchema>;
export type JournalStep = z.infer<typeof journalStepSchema>;
export type JournalStepStatus = z.infer<typeof journalStepStatusSchema>;
export type Plan = z.infer<typeof planSchema>;
export type PlanStage = Plan["stages"][number];
export type StageFile = z.infer<typeof stageSchema>;
export type StageOutput = z.infer<typeof stageOutputSchema>;
export type Inventory = z.infer<typeof inventorySchema>;
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;
export type AgentEvent = z.infer<typeof eventSchema>;
