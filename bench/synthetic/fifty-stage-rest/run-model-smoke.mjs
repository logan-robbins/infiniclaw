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
const stageCount = Number.parseInt(args.stages ?? "1", 10);
const maxRepairs = Number.parseInt(args.maxRepairs ?? "2", 10);
const profile = args.profile ?? "basic";
const outDir = path.resolve(
  args.out ?? (await mkdtemp(path.join(os.tmpdir(), "infiniclaw-model-smoke-"))),
);

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

await execFileAsync(process.execPath, [
  path.join(here, "generate-fixture.mjs"),
  "--out",
  outDir,
  "--stages",
  String(stageCount),
  "--profile",
  profile,
]);

const ctx = {
  workspaceDir: outDir,
  agent: "main",
  session: "synthetic-model-smoke",
};
let repairAttempts = 0;
let rejectedSeals = 0;

for (let index = 1; index <= stageCount; index += 1) {
  const stageId = `stage-${String(index).padStart(2, "0")}`;
  const functionName = profile === "api" || profile === "api-compute"
    ? `handleStage${String(index).padStart(2, "0")}`
    : `stage${String(index).padStart(2, "0")}`;
  const activated = await activateNextStage(path.join(outDir, "PLAN.md"), ctx);
  if (activated?.id !== stageId) {
    throw new Error(`expected ${stageId} to activate, got ${activated?.id ?? "none"}`);
  }

  const stagePath = path.join(outDir, "project-plan", `${stageId}.md`);
  await activateStageFile(stagePath, ctx);
  let code = await generateStageCode(chat, stageId, index, functionName, profile);
  let sealed = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    await writeFile(path.join(outDir, "src", `${stageId}.mjs`), code, "utf8");
    try {
      sealed = await sealStage({
        planPath: path.join(outDir, "PLAN.md"),
        stagePath,
        inventoryPath: path.join(outDir, "INVENTORY.md"),
        serviceCards: [serviceCard(stageId)],
        ctx,
      });
      break;
    } catch (error) {
      if (!isStageSealRejected(error) || attempt === maxRepairs) {
        throw error;
      }
      rejectedSeals += 1;
      repairAttempts += 1;
      console.error(
        `Repairing ${stageId} after verifier failure (${attempt + 1}/${maxRepairs})`,
      );
      code = await repairStageCode(
        chat,
        stageId,
        index,
        functionName,
        profile,
        code,
        summarizeSealFailure(error),
      );
    }
  }

  if (!sealed?.verifierRun.allPass) throw new Error(`stage verifier failed for ${stageId}`);
  if ((await readStage(stagePath)).status !== "SEALED") {
    throw new Error(`stage did not seal: ${stageId}`);
  }
  console.error(`sealed ${stageId}`);
}

const plan = await readPlan(path.join(outDir, "PLAN.md"));
const inventory = await readInventory(path.join(outDir, "INVENTORY.md"));
console.log(
  JSON.stringify(
    {
      ok: true,
      workspace: outDir,
      profile,
      stages: stageCount,
      sealed: plan.stages.filter((stage) => stage.status === "SEALED").length,
      inventory_entries: inventory.entries.length,
      rejected_seals: rejectedSeals,
      repair_attempts: repairAttempts,
    },
    null,
    2,
  ),
);

async function generateStageCode(chat, stageId, ordinal, functionName, profileName) {
  const userPrompt =
    profileName === "api-compute"
      ? apiComputePrompt(stageId, ordinal, functionName)
      : profileName === "api"
      ? apiPrompt(stageId, ordinal, functionName)
      : basicPrompt(stageId, functionName);
  const result = await chat({
    messages: [
      {
        role: "system",
        content:
          "You write small dependency-free JavaScript ES modules. Return only source code, no Markdown fences.",
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });
  return stripCodeFence(result.content).trimEnd() + "\n";
}

async function repairStageCode(
  chat,
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
  const result = await chat({
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
          "The previous implementation failed verification.",
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
  return stripCodeFence(result.content).trimEnd() + "\n";
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
    "Implement a pure REST-style handler. Do not import anything.",
    "The verifier passes request.path, not request.url.",
    `Only accept method "POST" and path ${JSON.stringify(route)}.`,
    `Only accept authorization header exactly ${JSON.stringify(`Bearer ${token}`)}.`,
    `Valid body is exactly an object with id ${JSON.stringify(stageId)} and value ${ordinal}.`,
    `For a valid request return { status: 200, body: { ok: true, route: ${JSON.stringify(route)}, id: ${JSON.stringify(stageId)}, value: ${ordinal}, checksum: ${JSON.stringify(`${stageId}:${ordinal}`)} } }.`,
    'For missing or invalid authorization return { status: 401, body: { error: "unauthorized" } }.',
    'For wrong method or path return { status: 404, body: { error: "not_found" } }.',
    'For invalid body return { status: 400, body: { error: "bad_request" } }.',
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
    "Implement a pure dependency-free JavaScript compute API handler. Do not import anything.",
    "The verifier passes request.path, not request.url.",
    `Only accept method "POST" and path ${JSON.stringify(route)}.`,
    `Only accept authorization header exactly ${JSON.stringify(`Bearer ${token}`)}.`,
    `Valid body shape is exactly { id: ${JSON.stringify(stageId)}, value: integer, values: [integer, integer, integer], mode: "sum" | "mix" }.`,
    `For mode "sum": result = value + values[0] + values[1] + values[2] + ${ordinal}.`,
    `For mode "mix": result = ((value * ${ordinal + 3}) + values[0] - values[1] + values[2]) modulo ${modulus}, normalized to 0..${modulus - 1}.`,
    `Checksum is ${JSON.stringify(`${stageId}:`)} + mode + ":" + result + ":" + (result modulo ${checkModulus}).`,
    `For a valid request return { status: 200, body: { ok: true, route: ${JSON.stringify(route)}, id: ${JSON.stringify(stageId)}, mode, result, checksum } }.`,
    'For missing or invalid authorization return { status: 401, body: { error: "unauthorized" } }.',
    'For wrong method or path return { status: 404, body: { error: "not_found" } }.',
    'For invalid body return { status: 400, body: { error: "bad_request" } }.',
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
    summary: `${stageId} model smoke service`,
    interfaceMarkdown: `Sealed synthetic output for ${stageId}.`,
  };
}

function isStageSealRejected(error) {
  return error instanceof Error && error.name === "StageSealRejectedError";
}

function summarizeSealFailure(error) {
  const verifierRun = error?.verifierRun;
  if (!verifierRun?.results) return String(error?.message ?? error);
  return verifierRun.results
    .filter(({ result }) => !result.pass)
    .map(({ verifier, result }) =>
      [
        `${verifier.type}: ${result.detail}`,
        result.evidence ? result.evidence.slice(0, 800) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
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
