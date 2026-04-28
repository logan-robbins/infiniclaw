#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const args = parseArgs(process.argv.slice(2));
await loadEnvFile(args.envFile ?? (await findEnvFile(repoRoot)));

const stageCount = Number.parseInt(args.stages ?? "10", 10);
const maxRepairs = Number.parseInt(args.maxRepairs ?? "2", 10);
const profile = args.profile ?? "api";
const outDir = path.resolve(
  args.out ?? (await mkdtemp(path.join(os.tmpdir(), "infiniclaw-model-compare-"))),
);
const baselineDir = path.join(outDir, "baseline");
const infiniClawDir = path.join(outDir, "infiniclaw");

if (!Number.isInteger(stageCount) || stageCount <= 0) {
  throw new Error(`--stages must be a positive integer, got ${args.stages}`);
}
if (!["basic", "api", "api-compute"].includes(profile)) {
  throw new Error(`--profile must be basic, api, or api-compute, got ${profile}`);
}
if (!Number.isInteger(maxRepairs) || maxRepairs < 0) {
  throw new Error(`--max-repairs must be a nonnegative integer, got ${args.maxRepairs}`);
}

const { createEnvChatModel } = await importDist("providers/openai-compatible.js");
const { activateNextStage, readPlan } = await importDist("plan/plan.js");
const { activateStageFile, readStage } = await importDist("plan/stage.js");
const { sealStage } = await importDist("plan/seal.js");
const { readInventory } = await importDist("inventory/registry.js");
const { runAllDoD } = await importDist("verify/runner.js");

const chat = createEnvChatModel(process.env);
if (!chat) {
  throw new Error(
    [
      "No doer model configured.",
      "Set INFINICLAW_DOER_PROVIDER plus provider credentials/model.",
      "Examples:",
      "  INFINICLAW_DOER_PROVIDER=openai INFINICLAW_DOER_MODEL=<model> OPENAI_API_KEY=...",
      "  INFINICLAW_DOER_PROVIDER=openai-compatible INFINICLAW_DOER_BASE_URL=http://127.0.0.1:4000/v1 INFINICLAW_DOER_MODEL=<model> INFINICLAW_DOER_API_KEY=...",
      "  INFINICLAW_DOER_PROVIDER=kimi MOONSHOT_API_KEY=...",
    ].join("\n"),
  );
}

await generateFixture(baselineDir, stageCount, profile);
await generateFixture(infiniClawDir, stageCount, profile);

const ctx = {
  workspaceDir: infiniClawDir,
  agent: "main",
  session: "synthetic-model-comparison",
};
const metrics = {
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};
const baseline = {
  claimed_done: stageCount,
  verified_pass: 0,
  false_done: 0,
  failed_stages: [],
};
const infiniClaw = {
  sealed: 0,
  rejected_seals: 0,
  repair_attempts: 0,
  failed_stages: [],
};

for (let index = 1; index <= stageCount; index += 1) {
  const stageId = stageIdFor(index);
  const functionName = functionNameFor(index, profile);
  const firstAttempt = await generateStageCode(chat, stageId, index, functionName, profile);
  addUsage(metrics, firstAttempt.raw);
  metrics.calls += 1;

  await writeFile(path.join(baselineDir, "src", `${stageId}.mjs`), firstAttempt.content, "utf8");
  const baselineStage = await readStage(
    path.join(baselineDir, "project-plan", `${stageId}.md`),
  );
  const baselineRun = await runAllDoD(baselineStage.definitionOfDone, {
    workspaceDir: baselineDir,
  });
  if (baselineRun.allPass) {
    baseline.verified_pass += 1;
  } else {
    baseline.failed_stages.push({
      stage: stageId,
      failures: summarizeRunFailures(baselineRun),
    });
  }

  const stagePath = path.join(infiniClawDir, "project-plan", `${stageId}.md`);
  const activated = await activateNextStage(path.join(infiniClawDir, "PLAN.md"), ctx);
  if (activated?.id !== stageId) {
    throw new Error(`expected ${stageId} to activate, got ${activated?.id ?? "none"}`);
  }
  await activateStageFile(stagePath, ctx);

  let code = firstAttempt.content;
  let sealed = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    await writeFile(path.join(infiniClawDir, "src", `${stageId}.mjs`), code, "utf8");
    try {
      sealed = await sealStage({
        planPath: path.join(infiniClawDir, "PLAN.md"),
        stagePath,
        inventoryPath: path.join(infiniClawDir, "INVENTORY.md"),
        serviceCards: [serviceCard(stageId)],
        ctx,
      });
      break;
    } catch (error) {
      if (!isStageSealRejected(error) || attempt === maxRepairs) {
        infiniClaw.failed_stages.push({
          stage: stageId,
          failures: [summarizeSealFailure(error)],
        });
        throw error;
      }
      infiniClaw.rejected_seals += 1;
      infiniClaw.repair_attempts += 1;
      console.error(
        `Repairing ${stageId} after verifier failure (${attempt + 1}/${maxRepairs})`,
      );
      const repaired = await repairStageCode(
        chat,
        stageId,
        index,
        functionName,
        profile,
        code,
        summarizeSealFailure(error),
      );
      addUsage(metrics, repaired.raw);
      metrics.calls += 1;
      code = repaired.content;
    }
  }

  if (!sealed?.verifierRun.allPass) throw new Error(`stage verifier failed for ${stageId}`);
  if ((await readStage(stagePath)).status !== "SEALED") {
    throw new Error(`stage did not seal: ${stageId}`);
  }
  console.error(
    `stage ${stageId}: baseline=${baselineRun.allPass ? "pass" : "false_done"} infiniclaw=sealed`,
  );
}

baseline.false_done = stageCount - baseline.verified_pass;
const plan = await readPlan(path.join(infiniClawDir, "PLAN.md"));
const inventory = await readInventory(path.join(infiniClawDir, "INVENTORY.md"));
infiniClaw.sealed = plan.stages.filter((stage) => stage.status === "SEALED").length;

console.log(
  JSON.stringify(
    {
      ok: infiniClaw.sealed === stageCount && baseline.false_done > 0,
      workspace: outDir,
      profile,
      stages: stageCount,
      baseline,
      infiniclaw: {
        ...infiniClaw,
        inventory_entries: inventory.entries.length,
      },
      model_usage: metrics,
    },
    null,
    2,
  ),
);

async function generateStageCode(chatModel, stageId, ordinal, functionName, profileName) {
  const prompt =
    profileName === "api-compute"
      ? apiComputePrompt(stageId, ordinal, functionName)
      : profileName === "api"
      ? apiPrompt(stageId, ordinal, functionName)
      : basicPrompt(stageId, functionName);
  const result = await chatModel({
    messages: [
      {
        role: "system",
        content:
          "You write small dependency-free JavaScript ES modules. Return only source code, no Markdown fences.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  return { content: stripCodeFence(result.content).trimEnd() + "\n", raw: result.raw };
}

async function repairStageCode(
  chatModel,
  stageId,
  ordinal,
  functionName,
  profileName,
  previousCode,
  failureSummary,
) {
  const basePrompt =
    profileName === "api-compute"
      ? apiComputePrompt(stageId, ordinal, functionName)
      : profileName === "api"
      ? apiPrompt(stageId, ordinal, functionName)
      : basicPrompt(stageId, functionName);
  const result = await chatModel({
    messages: [
      {
        role: "system",
        content:
          "You repair JavaScript ES modules to satisfy exact verifier failures. Return only source code, no Markdown fences.",
      },
      {
        role: "user",
        content: [
          basePrompt,
          "",
          "The previous implementation failed hidden benchmark verification.",
          "Verifier failure summary:",
          failureSummary,
          repairHints(profileName),
          "",
          "Previous implementation:",
          previousCode,
          "",
          "Repair the file so every verifier passes.",
        ].join("\n"),
      },
    ],
  });
  return { content: stripCodeFence(result.content).trimEnd() + "\n", raw: result.raw };
}

function basicPrompt(stageId, functionName) {
  return [
    `Create src/${stageId}.mjs.`,
    `It must export function ${functionName}().`,
    `The function must return exactly ${JSON.stringify(stageId)}.`,
    "Do not include console.log, TODO, FIXME, imports, dependencies, or explanations.",
  ].join("\n");
}

function apiPrompt(stageId, ordinal, functionName) {
  const route = `/api/${stageId}`;
  const token = `${stageId}-token`;
  return [
    `Create src/${stageId}.mjs.`,
    `It must export function ${functionName}(request).`,
    "Implement a pure dependency-free REST-style handler.",
    "The request object has method, path, headers, and body fields; use request.path for routing.",
    `The route is ${JSON.stringify(route)} and the only successful method is "POST".`,
    `The authorization header must be exactly ${JSON.stringify(`Bearer ${token}`)}.`,
    `The valid body is exactly { id: ${JSON.stringify(stageId)}, value: ${ordinal} }.`,
    `A valid request returns { status: 200, body: { ok: true, route: ${JSON.stringify(route)}, id: ${JSON.stringify(stageId)}, value: ${ordinal}, checksum: ${JSON.stringify(`${stageId}:${ordinal}`)} } }.`,
    'Missing or invalid authorization returns { status: 401, body: { error: "unauthorized" } }.',
    'Wrong method or path returns { status: 404, body: { error: "not_found" } }.',
    'Invalid body returns { status: 400, body: { error: "bad_request" } }.',
    "Do not include console.log, TODO, FIXME, fetch, imports, dependencies, Markdown, or explanations.",
  ].join("\n");
}

function apiComputePrompt(stageId, ordinal, functionName) {
  const route = `/api/${stageId}/compute`;
  const token = `${stageId}-token`;
  const modulus = 997;
  const checkModulus = ordinal + 5;
  return [
    `Create src/${stageId}.mjs.`,
    `It must export function ${functionName}(request).`,
    "Implement a pure dependency-free JavaScript compute API handler.",
    "The request object has method, path, headers, and body fields; use request.path for routing.",
    `The route is ${JSON.stringify(route)} and the only successful method is "POST".`,
    `The authorization header must be exactly ${JSON.stringify(`Bearer ${token}`)}.`,
    `Valid body shape is exactly { id: ${JSON.stringify(stageId)}, value: integer, values: [integer, integer, integer], mode: "sum" | "mix" }.`,
    `For mode "sum", compute result = value + values[0] + values[1] + values[2] + ${ordinal}.`,
    `For mode "mix", compute result = ((value * ${ordinal + 3}) + values[0] - values[1] + values[2]) modulo ${modulus}, normalized to 0..${modulus - 1}.`,
    `Checksum is ${JSON.stringify(`${stageId}:`)} + mode + ":" + result + ":" + (result modulo ${checkModulus}).`,
    `A valid request returns { status: 200, body: { ok: true, route: ${JSON.stringify(route)}, id: ${JSON.stringify(stageId)}, mode, result, checksum } }.`,
    'Missing or invalid authorization returns { status: 401, body: { error: "unauthorized" } }.',
    'Wrong method or path returns { status: 404, body: { error: "not_found" } }.',
    'Invalid body returns { status: 400, body: { error: "bad_request" } }.',
    "Do not include console.log, TODO, FIXME, fetch, imports, dependencies, Markdown, or explanations.",
  ].join("\n");
}

function repairHints(profileName) {
  if (profileName !== "api-compute") return "";
  return [
    "",
    "Repair checklist for api-compute:",
    "- Check request.path and request.method before authorization.",
    "- Read the bearer token from request.headers.authorization; optionally support request.headers.Authorization too.",
    "- Reject the body unless it is a non-array object with exactly these four keys: id, value, values, mode.",
    "- Reject any extra body field.",
    "- Require Number.isInteger(value).",
    "- Require values to be an array of exactly three integers.",
    "- Only accept mode values \"sum\" and \"mix\".",
    "- Preserve the exact status/body error shapes from the prompt.",
  ].join("\n");
}

async function generateFixture(outDir, stages, profileName) {
  await execFileAsync(process.execPath, [
    path.join(here, "generate-fixture.mjs"),
    "--out",
    outDir,
    "--stages",
    String(stages),
    "--profile",
    profileName,
  ]);
}

async function importDist(relativePath) {
  const filePath = path.join(
    repoRoot,
    "packages/directive-persistence/dist",
    relativePath,
  );
  try {
    return await import(pathToFileURL(filePath).href);
  } catch (error) {
    throw new Error(
      `Unable to import ${filePath}. Build first with: cd packages/directive-persistence && ../../node_modules/.bin/tsc -p tsconfig.json\n${error}`,
    );
  }
}

function summarizeRunFailures(run) {
  return run.results
    .filter(({ result }) => !result.pass)
    .map(({ verifier, result }) =>
      [
        `${verifier.type}: ${result.detail}`,
        result.evidence ? result.evidence.slice(0, 800) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
}

function summarizeSealFailure(error) {
  const verifierRun = error?.verifierRun;
  if (!verifierRun?.results) return String(error?.message ?? error);
  return summarizeRunFailures(verifierRun).join("\n\n");
}

function addUsage(metrics, raw) {
  const usage = raw && typeof raw === "object" ? raw.usage : undefined;
  if (!usage || typeof usage !== "object") return;
  metrics.prompt_tokens += numberValue(usage.prompt_tokens);
  metrics.completion_tokens += numberValue(usage.completion_tokens);
  metrics.total_tokens += numberValue(usage.total_tokens);
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stripCodeFence(content) {
  const trimmed = content.trim();
  const match = /^```(?:javascript|js|mjs)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function serviceCard(stageId) {
  return {
    name: stageId,
    stage: stageId,
    path: `inventory/${stageId}.md`,
    summary: `${stageId} model comparison service`,
    interfaceMarkdown: `Sealed synthetic output for ${stageId}.`,
  };
}

function stageIdFor(index) {
  return `stage-${String(index).padStart(2, "0")}`;
}

function functionNameFor(index, profileName) {
  const suffix = String(index).padStart(2, "0");
  return profileName === "api" || profileName === "api-compute"
    ? `handleStage${suffix}`
    : `stage${suffix}`;
}

function isStageSealRejected(error) {
  return error instanceof Error && error.name === "StageSealRejectedError";
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--out" ||
      arg === "--stages" ||
      arg === "--env-file" ||
      arg === "--profile" ||
      arg === "--max-repairs"
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      const key =
        arg === "--env-file"
          ? "envFile"
          : arg === "--max-repairs"
            ? "maxRepairs"
            : arg.slice(2);
      parsed[key] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function findEnvFile(startDir) {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, ".env");
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function loadEnvFile(filePath) {
  if (!filePath) return;
  const content = await readFile(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue ?? "");
  }
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
