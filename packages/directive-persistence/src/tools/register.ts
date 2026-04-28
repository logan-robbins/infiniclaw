import path from "node:path";
import { z } from "zod";
import {
  markStepBlocked,
  markStepDone,
  recordVerifierRunInJournal,
  setStepProgress,
} from "../directives/journal.js";
import { parseDirectives } from "../directives/parse.js";
import { verifierSchema } from "../directives/schema.js";
import {
  taskBlockedReportSchema,
  taskCompleteReportSchema,
  validateTaskComplete,
} from "../spawn/parse-task-complete.js";
import { currentTurnForSession } from "../supervision/done-revert.js";
import { runDoDForStep } from "../verify/runner.js";

export type ToolContext = {
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
};

export type PluginTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
};

export type ToolSdk = {
  registerTool?: ((tool: PluginTool) => void) | ((name: string, tool: PluginTool, handler: PluginTool["handler"]) => void);
  tool?: ((tool: PluginTool) => void) | ((name: string, tool: PluginTool, handler: PluginTool["handler"]) => void);
};

const verifierRunInputSchema = z.object({
  step_id: z.string().min(1),
  dod: z.array(verifierSchema).optional(),
});

const writeDoneInputSchema = z.object({
  step_id: z.string().min(1),
  verified_outputs: z.array(z.string()).optional(),
});

const setProgressInputSchema = z.object({
  step_id: z.string().min(1),
  progress: z.string().min(1),
});

const markBlockedInputSchema = z.object({
  step_id: z.string().min(1),
  blocker: z.string().min(1),
});

export function registerTools(sdk?: ToolSdk): void {
  const registerTool = sdk?.registerTool ?? sdk?.tool;
  if (!registerTool) return;
  const register = registerTool as (...args: unknown[]) => void;
  for (const tool of buildTools()) {
    if (register.length >= 2) {
      register(tool.name, tool, tool.handler);
    } else {
      register(tool);
    }
  }
}

export function buildTools(): PluginTool[] {
  return [
    {
      name: "verifier.run",
      description: "Run the Definition of Done verifiers for a JOURNAL step.",
      inputSchema: verifierRunInputSchema,
      handler: verifierRunTool,
    },
    {
      name: "journal.write_done",
      description: "Mark a JOURNAL step DONE after a same-turn verifier allPass.",
      inputSchema: writeDoneInputSchema,
      handler: writeDoneTool,
    },
    {
      name: "journal.set_progress",
      description: "Set the current progress text for a JOURNAL step.",
      inputSchema: setProgressInputSchema,
      handler: setProgressTool,
    },
    {
      name: "journal.mark_blocked",
      description: "Mark a JOURNAL step BLOCKED with a concrete blocker.",
      inputSchema: markBlockedInputSchema,
      handler: markBlockedTool,
    },
    {
      name: "report_task_complete",
      description: "Validate a child task completion report before parent acceptance.",
      inputSchema: taskCompleteReportSchema,
      handler: reportTaskCompleteTool,
    },
    {
      name: "report_task_blocked",
      description: "Validate a child task blocked report.",
      inputSchema: taskBlockedReportSchema,
      handler: reportTaskBlockedTool,
    },
  ];
}

async function verifierRunTool(input: unknown, ctx: ToolContext): Promise<unknown> {
  const parsed = verifierRunInputSchema.parse(input);
  const directives = await parseDirectives(path.join(ctx.workspaceDir, "DIRECTIVES.md"));
  const dod = parsed.dod ?? directives.definitionOfDone;
  const run = await runDoDForStep(parsed.step_id, dod, {
    workspaceDir: ctx.workspaceDir,
    agent: ctx.agentId,
    session: ctx.sessionKey,
    turnNo: currentTurnForSession(ctx.sessionKey),
  });
  await recordVerifierRunInJournal(
    path.join(ctx.workspaceDir, "JOURNAL.md"),
    parsed.step_id,
    run,
    journalCtx(ctx),
  );
  return summarizeVerifierRun(run);
}

async function writeDoneTool(input: unknown, ctx: ToolContext): Promise<unknown> {
  const parsed = writeDoneInputSchema.parse(input);
  const directives = await parseDirectives(path.join(ctx.workspaceDir, "DIRECTIVES.md"));
  const journal = await markStepDone(
    path.join(ctx.workspaceDir, "JOURNAL.md"),
    parsed.step_id,
    journalCtx(ctx),
    {
      dod: directives.definitionOfDone,
      verifiedOutputs: parsed.verified_outputs,
    },
  );
  const step = journal.taskStack.find((item) => item.id === parsed.step_id);
  return { ok: true, step_id: parsed.step_id, status: step?.status };
}

async function setProgressTool(input: unknown, ctx: ToolContext): Promise<unknown> {
  const parsed = setProgressInputSchema.parse(input);
  const journal = await setStepProgress(
    path.join(ctx.workspaceDir, "JOURNAL.md"),
    parsed.step_id,
    parsed.progress,
    journalCtx(ctx),
  );
  const step = journal.taskStack.find((item) => item.id === parsed.step_id);
  return { ok: true, step_id: parsed.step_id, status: step?.status };
}

async function markBlockedTool(input: unknown, ctx: ToolContext): Promise<unknown> {
  const parsed = markBlockedInputSchema.parse(input);
  const journal = await markStepBlocked(
    path.join(ctx.workspaceDir, "JOURNAL.md"),
    parsed.step_id,
    parsed.blocker,
    journalCtx(ctx),
  );
  const step = journal.taskStack.find((item) => item.id === parsed.step_id);
  return { ok: true, step_id: parsed.step_id, status: step?.status };
}

async function reportTaskCompleteTool(input: unknown, ctx: ToolContext): Promise<unknown> {
  const report = taskCompleteReportSchema.parse(input);
  await validateTaskComplete({
    report,
    agent: ctx.agentId,
    directivesPath: path.join(ctx.workspaceDir, "DIRECTIVES.md"),
    workspaceDir: ctx.workspaceDir,
  });
  return { ok: true, status: "accepted" };
}

async function reportTaskBlockedTool(input: unknown): Promise<unknown> {
  const report = taskBlockedReportSchema.parse(input);
  return {
    ok: true,
    status: "blocked",
    classification: report.classification,
    step_id: report.step_id,
  };
}

function journalCtx(ctx: ToolContext) {
  return {
    workspaceDir: ctx.workspaceDir,
    agent: ctx.agentId,
    session: ctx.sessionKey,
  };
}

function summarizeVerifierRun(run: Awaited<ReturnType<typeof runDoDForStep>>) {
  return {
    allPass: run.allPass,
    verifierRunId: run.verifierRunId,
    dodHash: run.dodHash,
    results: run.results.map(({ verifier, result }) => ({
      type: verifier.type,
      pass: result.pass,
      detail: result.detail,
      evidence: result.evidence,
    })),
  };
}
