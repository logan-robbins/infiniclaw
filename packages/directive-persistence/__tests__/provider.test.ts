import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvChatModel,
  resolveOpenAICompatibleConfig,
  type FetchLike,
} from "../src/providers/openai-compatible.js";
import { runVerifier } from "../src/verify/runner.js";

const tempRoots: string[] = [];
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(async () => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OpenAI-compatible model providers", () => {
  it("resolves Kimi as the default low-cost long-run provider", () => {
    const config = resolveOpenAICompatibleConfig({
      INFINICLAW_JUDGE_PROVIDER: "kimi",
      MOONSHOT_API_KEY: "moon-test-key",
    });

    expect(config).toMatchObject({
      provider: "kimi",
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: "moon-test-key",
      model: "kimi-k2.6",
    });
  });

  it("runs llm_judge through the configured provider and includes file inputs", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "report.md"), "The artifact answers the task.\n", "utf8");

    process.env.INFINICLAW_JUDGE_PROVIDER = "kimi";
    process.env.MOONSHOT_API_KEY = "moon-test-key";

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    score: 8.5,
                    rationale: "The artifact meets the rubric.",
                  }),
                },
              },
            ],
          }),
      };
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runVerifier(
      {
        type: "llm_judge",
        rubric: "Score whether the artifact answers the task.",
        inputs: [{ path: "report.md" }],
        min_score: 8,
      },
      { workspaceDir: dir },
    );

    expect(result).toMatchObject({ pass: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(calls[0]!.body.model).toBe("kimi-k2.6");

    const messages = calls[0]!.body.messages as Array<{ content: string }>;
    expect(messages[1]!.content).toContain("The artifact answers the task.");
  });

  it("runs a configured doer chat model without touching judge settings", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "export function stage01() { return 'stage-01'; }" } }],
          }),
      };
    };

    const chat = createEnvChatModel(
      {
        INFINICLAW_DOER_PROVIDER: "openai-compatible",
        INFINICLAW_DOER_BASE_URL: "http://127.0.0.1:4000/v1/",
        INFINICLAW_DOER_API_KEY: "local-key",
        INFINICLAW_DOER_MODEL: "cheap-local-model",
        INFINICLAW_DOER_THINKING: "disabled",
        INFINICLAW_DOER_REASONING_EFFORT: "low",
      },
      fetchMock,
    );

    expect(chat).toBeDefined();
    const result = await chat!({
      messages: [
        { role: "system", content: "Write only code." },
        { role: "user", content: "Create stage01." },
      ],
    });

    expect(result.content).toContain("stage01");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    expect(calls[0]!.body).toMatchObject({
      model: "cheap-local-model",
      thinking: { type: "disabled" },
      reasoning_effort: "low",
    });
  });

  it("redacts provider error details before surfacing failures", async () => {
    const fetchMock: FetchLike = async () => ({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({
          error: {
            message:
              "account org-secret1234567890 with key ak-secret1234567890 is over quota",
            type: "exceeded_current_quota_error",
          },
        }),
    });

    const chat = createEnvChatModel(
      {
        INFINICLAW_DOER_PROVIDER: "openai-compatible",
        INFINICLAW_DOER_BASE_URL: "http://127.0.0.1:4000/v1",
        INFINICLAW_DOER_API_KEY: "local-key",
        INFINICLAW_DOER_MODEL: "cheap-local-model",
      },
      fetchMock,
    );

    await expect(
      chat!({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow(/HTTP 429: exceeded_current_quota_error/u);
    await expect(
      chat!({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.not.toThrow(/org-secret|ak-secret/u);
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "infiniclaw-provider-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
