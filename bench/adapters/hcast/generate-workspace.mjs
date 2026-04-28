#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.spec) throw new Error("--spec is required");
if (!args.out) throw new Error("--out is required");

const specPath = path.resolve(args.spec);
const outDir = path.resolve(args.out);
const includeLocalScoreHelper = Boolean(args.withLocalScoreHelper);
const spec = normalizeSpec(JSON.parse(await readFile(specPath, "utf8")));
const created = new Date().toISOString();

await mkdir(outDir, { recursive: true });
await mkdir(path.join(outDir, "project-plan"), { recursive: true });
await mkdir(path.join(outDir, "inventory"), { recursive: true });
await mkdir(path.join(outDir, ".infiniclaw"), { recursive: true });

const stageSpecs = buildStages(spec, includeLocalScoreHelper);
await writeFile(path.join(outDir, "PLAN.md"), buildPlan(spec, stageSpecs, created), "utf8");
await writeFile(path.join(outDir, "DIRECTIVES.md"), buildDirectives(spec, stageSpecs, created, outDir), "utf8");
await writeFile(path.join(outDir, "JOURNAL.md"), buildJournal(stageSpecs, created), "utf8");
await writeFile(path.join(outDir, "INVENTORY.md"), buildInventory(), "utf8");
await writeFile(
  path.join(outDir, ".infiniclaw", "hcast-task.json"),
  `${JSON.stringify(redactedTaskMetadata(spec, includeLocalScoreHelper), null, 2)}\n`,
  "utf8",
);

if (includeLocalScoreHelper) {
  if (!spec.score) {
    throw new Error("--with-local-score-helper requires spec.score");
  }
  await writeFile(
    path.join(outDir, ".infiniclaw", "score-threshold.mjs"),
    localScoreHelperSource(),
    "utf8",
  );
}

for (const [index, stage] of stageSpecs.entries()) {
  await writeFile(
    path.join(outDir, "project-plan", `${stage.id}.md`),
    buildStageFile(spec, stage, index, stageSpecs, created),
    "utf8",
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      workspace: outDir,
      task_family: spec.taskFamily,
      task_name: spec.taskName,
      stages: stageSpecs.length,
      local_score_helper: includeLocalScoreHelper,
    },
    null,
    2,
  ),
);

function normalizeSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("spec must be a JSON object");
  }
  const taskFamily = stringField(raw, "task_family", "taskFamily");
  const taskName = stringField(raw, "task_name", "taskName");
  const instructions = stringField(raw, "instructions");
  const submission = normalizeSubmission(raw.submission);
  const publicVerifiers = normalizeVerifiers(raw.public_verifiers ?? raw.publicVerifiers ?? []);
  const score = raw.score ? normalizeScore(raw.score) : undefined;
  const stages = Array.isArray(raw.stages)
    ? raw.stages.map((stage, index) => normalizeStage(stage, index, submission))
    : undefined;

  return {
    schemaVersion: Number(raw.schema_version ?? raw.schemaVersion ?? 1),
    benchmark: stringField(raw, "benchmark", undefined, "metr-task-standard"),
    taskFamily,
    taskName,
    tier: optionalString(raw.tier),
    expertise: optionalString(raw.expertise),
    instructions,
    submission,
    publicVerifiers,
    score,
    stages,
    turnBudgetTotal: positiveInteger(raw.turn_budget_total ?? raw.turnBudgetTotal, stages ? stages.length * 40 : 80),
    costBudgetUsd: positiveNumber(raw.cost_budget_usd ?? raw.costBudgetUsd, 10),
    notes: optionalString(raw.notes),
  };
}

function normalizeSubmission(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    path: optionalString(value.path) ?? "submission.txt",
    format: optionalString(value.format) ?? "Task Standard submission string or artifact",
  };
}

function normalizeScore(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("score must be an object");
  }
  return {
    command: stringField(raw, "command"),
    min: positiveNumber(raw.min, 1),
    timeoutSec: positiveInteger(raw.timeout_sec ?? raw.timeoutSec, 300),
    cwd: optionalString(raw.cwd) ?? ".",
  };
}

function normalizeStage(raw, index, submission) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`stages[${index}] must be an object`);
  }
  const id = optionalString(raw.id) ?? `stage-${String(index + 1).padStart(2, "0")}`;
  return {
    id: slugStageId(id, index + 1),
    title: optionalString(raw.title) ?? `Stage ${index + 1}`,
    goal: optionalString(raw.goal) ?? "Make progress on the benchmark task.",
    outputPaths: stringArray(raw.output_paths ?? raw.outputPaths ?? [submission.path]),
    definitionOfDone: normalizeVerifiers(raw.definition_of_done ?? raw.definitionOfDone ?? []),
    context: stringArray(raw.context ?? []),
    turnBudget: positiveInteger(raw.turn_budget ?? raw.turnBudget, 40),
  };
}

function buildStages(spec, includeLocalScoreHelper) {
  if (spec.stages?.length) {
    const stages = spec.stages.map((stage, index) => ({
      ...stage,
      definitionOfDone: stage.definitionOfDone.length
        ? stage.definitionOfDone
        : defaultDoD(spec, includeLocalScoreHelper, index === spec.stages.length - 1),
    }));
    return stages;
  }
  return [
    {
      id: "stage-01-solve",
      title: "Solve Task Standard task",
      goal: "Complete the benchmark task and produce the required submission artifact.",
      outputPaths: [spec.submission.path],
      definitionOfDone: defaultDoD(spec, includeLocalScoreHelper, true),
      context: [],
      turnBudget: 80,
    },
  ];
}

function defaultDoD(spec, includeLocalScoreHelper, isFinalStage) {
  const dod = [
    { type: "file_exists", path: spec.submission.path },
    ...spec.publicVerifiers,
  ];
  if (includeLocalScoreHelper && isFinalStage) {
    dod.push({
      type: "shell_exit_zero",
      cmd: "node .infiniclaw/score-threshold.mjs",
      timeout_s: spec.score?.timeoutSec ?? 300,
    });
  }
  return dedupeVerifiers(dod);
}

function buildPlan(spec, stages, created) {
  const lines = [
    `# PLAN - HCAST Task ${spec.taskFamily}/${spec.taskName}`,
    "schema_version: 1",
    `created: ${created}`,
    `last_replanned: ${created}`,
    "status: ACTIVE",
    "owner: main",
    `turn_budget_total: ${spec.turnBudgetTotal}`,
    `cost_budget_usd: ${spec.costBudgetUsd.toFixed(2)}`,
    "",
    "## Goal",
    [
      `Complete METR Task Standard task ${spec.taskFamily}/${spec.taskName}.`,
      spec.tier ? `Target horizon tier: ${spec.tier}.` : "",
      spec.expertise ? `Expertise tag: ${spec.expertise}.` : "",
      "",
      "Official task instructions:",
      spec.instructions.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
    "",
    "## High-Level Definition of Done",
    yamlList(defaultDoD(spec, false, true)),
    "",
    "## Stages",
  ];
  for (const [index, stage] of stages.entries()) {
    const depends = index === 0 ? "" : ` | depends: [${stages[index - 1].id}]`;
    lines.push(`${index + 1}. ${stage.id} | PENDING${depends}`);
  }
  lines.push(
    "",
    "## Sealed Outputs Registry",
    "# (empty)",
    "",
    "## Global Constraints",
    "- Treat the benchmark's official task environment and scoring as external authority.",
    "- Do not edit DIRECTIVES.md.",
    "- Do not assume hidden scoring details beyond public instructions and public verifiers.",
    "- Write the final submission artifact exactly where the Output Contract requires.",
    "",
    "## Notes",
    spec.notes ?? "Generated by bench/adapters/hcast/generate-workspace.mjs.",
  );
  return `${lines.join("\n")}\n`;
}

function buildDirectives(spec, stages, created, workspace) {
  return `# DIRECTIVES (immutable for this agent's lifetime)
schema_version: 1
agent: main
parent: null
workspace: ${workspace}
spawned: ${created}
journal: ./JOURNAL.md

## GOAL
Complete the benchmark task defined in ./PLAN.md and produce ${spec.submission.path}.

## INPUT CONTRACT
- path: PLAN.md
- path: project-plan/
- path: .infiniclaw/hcast-task.json

## OUTPUT CONTRACT
- kind: file
  path: ${spec.submission.path}
  exports: []
  interface: "${escapeDoubleQuoted(spec.submission.format)}"

## DEFINITION OF DONE
${yamlList(defaultDoD(spec, false, true))}

## CONSTRAINTS
- Treat DIRECTIVES.md as immutable.
- Follow the benchmark instructions in PLAN.md.
- Do not rely on hidden scoring internals.
- Use verifier results as progress evidence, but the official benchmark score remains external.

## TURN BUDGET
max_turns: ${spec.turnBudgetTotal}
warning_at: ${Math.floor(spec.turnBudgetTotal * 0.8)}
escalate_at: ${Math.floor(spec.turnBudgetTotal * 0.95)}

## INITIAL DECOMPOSITION
${stages.map((stage, index) => `- step-${index + 1}: ${stage.goal}`).join("\n")}

## PROTOCOL
You are an OpenClaw agent under the Persistent Directive System.
`;
}

function buildJournal(stages, created) {
  const maxTurns = stages.reduce((sum, stage) => sum + stage.turnBudget, 0);
  return `# JOURNAL
schema_version: 1
agent: main
last_updated: ${created}
turns_used: 0
max_turns: ${maxTurns}
warning_at: ${Math.floor(maxTurns * 0.8)}
escalate_at: ${Math.floor(maxTurns * 0.95)}
last_verifier_run: null

## TASK STACK

#### step-1: Execute benchmark plan
status: IN_PROGRESS
started: ${created}
progress: HCAST workspace generated; no stages sealed yet.
blocker: null

## WORKING NOTES
# (empty)

## SUB-AGENTS
# (empty)

## COMPLETION REPORT
# Written once, at TASK_COMPLETE. Empty until then.
`;
}

function buildInventory() {
  return `# INVENTORY
schema_version: 1
# One line per sealed output. Append-only. Sorted by stage order, not time.

`;
}

function buildStageFile(spec, stage, index, stages, created) {
  const previous = index === 0 ? undefined : stages[index - 1];
  const outputEntries = stage.outputPaths.map((outputPath) => ({
    kind: "file",
    path: outputPath,
    exports: [],
    interface: outputPath === spec.submission.path
      ? spec.submission.format
      : `Artifact for ${stage.id}`,
  }));
  outputEntries.push({
    kind: "service",
    path: `inventory/${stage.id}.md`,
    exports: [],
    interface: `${stage.id} sealed output card`,
  });

  return `# ${stage.title}
schema_version: 1
status: PENDING
created: ${created}
activated: null
sealed: null
turn_budget: ${stage.turnBudget}

## Depends On
${previous ? `- service: inventory/${previous.id}.md` : "# (empty)"}

## Output Contract
${yamlList(outputEntries)}

## Definition of Done
${yamlList(stage.definitionOfDone)}

## Sub-Tasks
A:
  id: ${stage.id}.A
  goal: "${escapeDoubleQuoted(stage.goal)}"
  input_contract:
    - path: PLAN.md
    - path: .infiniclaw/hcast-task.json
${previous ? `    - service: inventory/${previous.id}.md\n` : ""}  output_contract:
${stage.outputPaths.map((outputPath) => `    - path: ${outputPath}`).join("\n")}
  can_start: immediately
  turn_budget: ${Math.max(12, Math.floor(stage.turnBudget * 0.75))}
  preset: benchmark-implementation

## Context for Sub-Agents
${contextBullets(spec, stage)}

## Execution Log
# (empty)

## SEALED SUMMARY
# (empty)
`;
}

function contextBullets(spec, stage) {
  const lines = [
    `Benchmark task: ${spec.taskFamily}/${spec.taskName}`,
    `Stage goal: ${stage.goal}`,
    `Final submission path: ${spec.submission.path}`,
    "Official task instructions are in PLAN.md.",
    ...stage.context,
  ];
  return lines.map((line) => `- ${line}`).join("\n");
}

function redactedTaskMetadata(spec, includeLocalScoreHelper) {
  return {
    schema_version: 1,
    benchmark: spec.benchmark,
    task_family: spec.taskFamily,
    task_name: spec.taskName,
    tier: spec.tier,
    expertise: spec.expertise,
    instructions: spec.instructions,
    submission: spec.submission,
    public_verifiers: spec.publicVerifiers,
    score: includeLocalScoreHelper ? spec.score : undefined,
    official_score_external: !includeLocalScoreHelper,
  };
}

function localScoreHelperSource() {
  return `#!/usr/bin/env node
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const metadata = JSON.parse(await readFile(".infiniclaw/hcast-task.json", "utf8"));
if (!metadata.score?.command) throw new Error("No local score command configured");

const { stdout } = await execAsync(metadata.score.command, {
  cwd: metadata.score.cwd ?? ".",
  timeout: (metadata.score.timeoutSec ?? metadata.score.timeout_sec ?? 300) * 1000,
  maxBuffer: 1024 * 1024 * 10,
  env: {
    ...process.env,
    INFINICLAW_SUBMISSION_PATH: metadata.submission.path,
    INFINICLAW_TASK_FAMILY: metadata.task_family,
    INFINICLAW_TASK_NAME: metadata.task_name,
  },
});

const score = parseScore(stdout);
const minScore = Number(metadata.score.min ?? 1);
if (!Number.isFinite(score)) throw new Error("Score command did not emit a numeric score");
if (score < minScore) {
  console.error(\`score \${score} below threshold \${minScore}\`);
  process.exit(1);
}

function parseScore(output) {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "number") return parsed;
    if (typeof parsed?.score === "number") return parsed.score;
  } catch {}
  const match = /-?\\d+(?:\\.\\d+)?/.exec(trimmed);
  return match ? Number(match[0]) : Number.NaN;
}
`;
}

function normalizeVerifiers(raw) {
  if (!Array.isArray(raw)) throw new Error("verifiers must be an array");
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`verifier[${index}] must be an object`);
    }
    if (!optionalString(entry.type)) {
      throw new Error(`verifier[${index}] requires type`);
    }
    return entry;
  });
}

function dedupeVerifiers(verifiers) {
  const seen = new Set();
  const output = [];
  for (const verifier of verifiers) {
    const key = JSON.stringify(verifier);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(verifier);
  }
  return output;
}

function yamlList(value) {
  if (!value.length) return "# (empty)";
  return value.map((entry) => yamlValue(entry, 0, true)).join("\n");
}

function yamlValue(value, indent, listItem = false) {
  const pad = " ".repeat(indent);
  const prefix = listItem ? `${pad}- ` : pad;
  if (Array.isArray(value)) {
    if (!value.length) return `${prefix}[]`;
    const lines = [];
    if (listItem) lines.push(`${pad}-`);
    for (const child of value) lines.push(yamlValue(child, indent + (listItem ? 2 : 0), true));
    return lines.join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    if (!entries.length) return `${prefix}{}`;
    const lines = [];
    for (const [index, [key, child]] of entries.entries()) {
      const currentPrefix = index === 0 ? prefix : " ".repeat(indent + (listItem ? 2 : 0));
      if (child && typeof child === "object") {
        lines.push(`${currentPrefix}${key}:`);
        lines.push(yamlValue(child, indent + (listItem ? 4 : 2)));
      } else {
        lines.push(`${currentPrefix}${key}: ${yamlScalar(child)}`);
      }
    }
    return lines.join("\n");
  }
  return `${prefix}${yamlScalar(value)}`;
}

function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(text) && text !== "null" && text !== "true" && text !== "false") {
    return text;
  }
  return JSON.stringify(text);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--with-local-score-helper") {
      parsed.withLocalScoreHelper = true;
      continue;
    }
    if (arg === "--spec" || arg === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed[arg.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function stringField(raw, snake, camel, fallback) {
  const value = raw[snake] ?? (camel ? raw[camel] : undefined) ?? fallback;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${snake} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("expected string array");
    }
    return entry.trim();
  });
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`expected positive integer, got ${value}`);
  }
  return number;
}

function positiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`expected positive number, got ${value}`);
  }
  return number;
}

function slugStageId(value, ordinal) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (!slug) return `stage-${String(ordinal).padStart(2, "0")}`;
  return slug.startsWith("stage-") ? slug : `stage-${String(ordinal).padStart(2, "0")}-${slug}`;
}

function escapeDoubleQuoted(value) {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}
