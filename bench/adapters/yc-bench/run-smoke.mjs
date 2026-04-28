#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

const ycBenchDir = path.resolve(args.ycBenchDir ?? "/tmp/yc-bench");
const workDir = path.resolve(
  args.workDir ?? (await mkdtemp(path.join(os.tmpdir(), "infiniclaw-yc-bench-"))),
);
const model = args.model ?? "openai/gpt-5-mini";
const seed = positiveInteger(args.seed ?? "1", "--seed");
const fullRun = Boolean(args.full);
const maxTurns = fullRun ? undefined : positiveInteger(args.maxTurns ?? "12", "--max-turns");
const configFile = "infiniclaw-yc-bench.toml";
const configPath = path.join(workDir, configFile);
const timeoutMs = positiveInteger(args.timeoutMs ?? "900000", "--timeout-ms");

await preflight();
await mkdir(workDir, { recursive: true });
const generateArgs = [
  path.join(here, "generate-config.mjs"),
  "--out",
  configPath,
];
if (maxTurns !== undefined) {
  generateArgs.push("--max-turns", String(maxTurns));
}
await execFileAsync(process.execPath, generateArgs);

const childEnv = {
  ...process.env,
  ...readEnvFileIfPresent(args.envFile),
};

const result = await runYcBench(childEnv);
const summary = await summarizeRun(result);
console.log(JSON.stringify(summary, null, 2));

async function preflight() {
  const checks = [
    stat(ycBenchDir).catch(() => {
      throw new Error(`YC-Bench repo not found at ${ycBenchDir}`);
    }),
    execFileAsync("uv", ["--version"]),
  ];
  await Promise.all(checks);
}

async function runYcBench(env) {
  try {
    const completed = await execFileAsync(
      "uv",
      [
        "run",
        "--project",
        ycBenchDir,
        "yc-bench",
        "run",
        "--model",
        model,
        "--seed",
        String(seed),
        "--config",
        configFile,
        "--no-live",
      ],
      {
        cwd: workDir,
        env,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return { exitCode: 0, stdout: completed.stdout, stderr: completed.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

async function summarizeRun(processResult) {
  const slug = model.replaceAll("/", "_");
  const resultPath = path.join(
    workDir,
    "results",
    `yc_bench_result_${configFile}_${seed}_${slug}.json`,
  );
  let rollout = null;
  try {
    rollout = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    // Leave null; stderr/stdout in the summary identify setup/runtime failures.
  }

  const finalFunds = finalFundsCents(rollout);
  const taskStats = taskStatusSummary(rollout);
  const commandStats = commandSummary(rollout);
  return {
    ok: Boolean(rollout) && (processResult.exitCode === 0 || rollout.terminal_detail?.includes("max_turns")),
    work_dir: workDir,
    config: configPath,
    yc_bench_dir: ycBenchDir,
    model,
    seed,
    max_turns: maxTurns ?? null,
    process_exit_code: processResult.exitCode,
    terminal_reason: rollout?.terminal_reason ?? null,
    terminal_detail: rollout?.terminal_detail ?? null,
    turns_completed: rollout?.turns_completed ?? null,
    total_cost_usd: rollout?.total_cost_usd ?? null,
    final_funds_cents: finalFunds,
    final_net_worth_usd: finalFunds === null ? null : finalFunds / 100,
    scratchpad_chars: typeof rollout?.time_series?.scratchpad === "string" ? rollout.time_series.scratchpad.length : null,
    command_stats: commandStats,
    task_stats: taskStats,
    result_path: rollout ? resultPath : null,
    stderr_tail: tail(processResult.stderr),
    stdout_tail: tail(processResult.stdout),
  };
}

function commandSummary(rollout) {
  const transcript = rollout?.transcript;
  if (!Array.isArray(transcript)) return null;
  const commands = transcript.flatMap((turn) => turn.commands_executed ?? []);
  return {
    total: commands.length,
    sim_resume: commands.filter((command) => command.includes("yc-bench sim resume")).length,
    scratchpad_write: commands.filter((command) => command.includes("yc-bench scratchpad write")).length,
    task_accept: commands.filter((command) => command.includes("yc-bench task accept")).length,
    task_inspect: commands.filter((command) => command.includes("yc-bench task inspect")).length,
    task_dispatch: commands.filter((command) => command.includes("yc-bench task dispatch")).length,
    task_cancel: commands.filter((command) => command.includes("yc-bench task cancel")).length,
  };
}

function taskStatusSummary(rollout) {
  const tasks = rollout?.time_series?.tasks;
  if (!Array.isArray(tasks)) return null;
  const summary = {
    completed_success: 0,
    completed_fail: 0,
    active: 0,
    planned: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    if (task.status in summary) summary[task.status] += 1;
  }
  return summary;
}

function finalFundsCents(rollout) {
  const funds = rollout?.time_series?.funds;
  if (!Array.isArray(funds) || funds.length === 0) return null;
  const last = funds[funds.length - 1];
  return typeof last.funds_cents === "number" ? last.funds_cents : null;
}

function readEnvFileIfPresent(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  const text = readFileSyncUtf8(resolved);
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    env[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return env;
}

function readFileSyncUtf8(filePath) {
  return readFileSync(filePath, "utf8");
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tail(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.split(/\r?\n/).slice(-20).join("\n");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--yc-bench-dir") {
      if (!value) throw new Error("--yc-bench-dir requires a value");
      parsed.ycBenchDir = value;
      index += 1;
      continue;
    }
    if (arg === "--work-dir") {
      if (!value) throw new Error("--work-dir requires a value");
      parsed.workDir = value;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      if (!value) throw new Error("--model requires a value");
      parsed.model = value;
      index += 1;
      continue;
    }
    if (arg === "--seed") {
      if (!value) throw new Error("--seed requires a value");
      parsed.seed = value;
      index += 1;
      continue;
    }
    if (arg === "--max-turns") {
      if (parsed.full) throw new Error("--max-turns cannot be used with --full");
      if (!value) throw new Error("--max-turns requires a value");
      parsed.maxTurns = value;
      index += 1;
      continue;
    }
    if (arg === "--full") {
      if (parsed.maxTurns) throw new Error("--full cannot be used with --max-turns");
      parsed.full = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      if (!value) throw new Error("--timeout-ms requires a value");
      parsed.timeoutMs = value;
      index += 1;
      continue;
    }
    if (arg === "--env-file") {
      if (!value) throw new Error("--env-file requires a value");
      parsed.envFile = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
