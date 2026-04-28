import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("YC-Bench adapter", () => {
  it("generates a leaderboard-preserving config with InfiniClaw scratchpad protocol", async () => {
    const dir = await tempDir();
    const configPath = path.join(dir, "infiniclaw-yc-bench.toml");

    const { stdout } = await execFileAsync(process.execPath, [
      adapterScript("generate-config.mjs"),
      "--out",
      configPath,
      "--max-turns",
      "12",
    ]);

    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      ok: true,
      config: configPath,
      max_turns: 12,
      history_keep_rounds: 20,
    });

    const config = await readFile(configPath, "utf8");
    expect(config).toContain('extends = "default"');
    expect(config).toContain("[agent]");
    expect(config).toContain("Persistent Directive Protocol");
    expect(config).toContain("Never use task assign-all");
    expect(config).toContain("[loop]");
    expect(config).toContain("max_turns = 12");
  });
});

function adapterScript(name: string): string {
  return path.resolve(process.cwd(), "../../bench/adapters/yc-bench", name);
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-yc-bench-adapter-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
