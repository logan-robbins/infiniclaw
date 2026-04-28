import { readFile } from "node:fs/promises";
import type {
  LlmJudgeInput,
  LlmJudgeResult,
  VerifierContext,
} from "../verify/types/common.js";
import { resolveWorkspacePath } from "../verify/types/common.js";

export type OpenAICompatibleProvider = "kimi" | "openai" | "openai-compatible";
export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelRole = "judge" | "doer";
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type ChatCompletionInput = {
  messages: ChatMessage[];
  model?: string;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
};
export type ChatCompletionResult = {
  content: string;
  raw: unknown;
};

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type OpenAICompatibleConfig = {
  provider: OpenAICompatibleProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  fetchImpl?: FetchLike;
};

export type Env = Record<string, string | undefined>;

type ProviderPreset = {
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel?: string;
};

const PRESETS: Record<OpenAICompatibleProvider, ProviderPreset> = {
  kimi: {
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2.6",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "openai-compatible": {
    baseUrl: "",
    apiKeyEnv: "INFINICLAW_LLM_API_KEY",
  },
};

export class ModelProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderConfigError";
  }
}

export class LlmJudgeProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmJudgeProviderError";
  }
}

export function resolveOpenAICompatibleConfig(
  env: Env = process.env,
  role: ModelRole = "judge",
): OpenAICompatibleConfig | undefined {
  const prefix = role === "judge" ? "INFINICLAW_JUDGE" : "INFINICLAW_DOER";
  const provider = parseProvider(
    env[`${prefix}_PROVIDER`] ?? env.INFINICLAW_LLM_PROVIDER,
  );
  if (!provider) return undefined;

  const preset = PRESETS[provider];
  const baseUrl = trimTrailingSlash(
    env[`${prefix}_BASE_URL`] ??
      env.INFINICLAW_LLM_BASE_URL ??
      preset.baseUrl,
  );
  const apiKey =
    env[`${prefix}_API_KEY`] ??
    env.INFINICLAW_LLM_API_KEY ??
    env[preset.apiKeyEnv];
  const model =
    env[`${prefix}_MODEL`] ??
    env.INFINICLAW_LLM_MODEL ??
    preset.defaultModel;

  if (!baseUrl) {
    throw new ModelProviderConfigError(
      `missing base URL for ${provider}; set INFINICLAW_JUDGE_BASE_URL or INFINICLAW_LLM_BASE_URL`,
    );
  }
  if (!apiKey) {
    throw new ModelProviderConfigError(
      `missing API key for ${provider}; set INFINICLAW_JUDGE_API_KEY, INFINICLAW_LLM_API_KEY, or ${preset.apiKeyEnv}`,
    );
  }
  if (!model) {
    throw new ModelProviderConfigError(
      `missing model for ${provider}; set INFINICLAW_JUDGE_MODEL or INFINICLAW_LLM_MODEL`,
    );
  }

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    timeoutMs: parsePositiveInteger(env[`${prefix}_TIMEOUT_MS`]),
    thinking: parseThinking(env[`${prefix}_THINKING`]),
    reasoningEffort: parseReasoningEffort(env[`${prefix}_REASONING_EFFORT`]),
  };
}

export function createEnvLlmJudge(
  env: Env = process.env,
  fetchImpl?: FetchLike,
): ((input: LlmJudgeInput, ctx: VerifierContext) => Promise<LlmJudgeResult>) | undefined {
  const config = resolveOpenAICompatibleConfig(env);
  if (!config) return undefined;
  return createOpenAICompatibleLlmJudge({ ...config, fetchImpl });
}

export function createEnvChatModel(
  env: Env = process.env,
  fetchImpl?: FetchLike,
): ((input: ChatCompletionInput) => Promise<ChatCompletionResult>) | undefined {
  const config = resolveOpenAICompatibleConfig(env, "doer");
  if (!config) return undefined;
  return createOpenAICompatibleChatModel({ ...config, fetchImpl });
}

export function createOpenAICompatibleChatModel(
  config: OpenAICompatibleConfig,
): (input: ChatCompletionInput) => Promise<ChatCompletionResult> {
  return async (input) => {
    const thinking = input.thinking ?? config.thinking;
    const reasoningEffort = input.reasoningEffort ?? config.reasoningEffort;
    const body = {
      model: input.model ?? config.model,
      messages: input.messages,
      ...(thinking ? { thinking: { type: thinking } } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };
    const raw = await callChatCompletions(config, body);
    return { content: extractMessageContent(raw), raw };
  };
}

export function createOpenAICompatibleLlmJudge(
  config: OpenAICompatibleConfig,
): (input: LlmJudgeInput, ctx: VerifierContext) => Promise<LlmJudgeResult> {
  return async (input, ctx) => {
    const raw = await callChatCompletions(config, {
      model: input.judge_model ?? config.model,
      messages: [
        {
          role: "system",
          content:
            "You are an independent verifier. Return only JSON with numeric score and string rationale.",
        },
        {
          role: "user",
          content: await buildJudgePrompt(input, ctx),
        },
      ],
      ...(config.thinking
        ? { thinking: { type: config.thinking } }
        : {}),
      ...(config.reasoningEffort
        ? { reasoning_effort: config.reasoningEffort }
        : {}),
    });
    return parseJudgeResponse(raw);
  };
}

async function callChatCompletions(
  config: OpenAICompatibleConfig,
  body: Record<string, unknown>,
): Promise<unknown> {
  const fetchImpl = config.fetchImpl ?? defaultFetch();
  const controller = new AbortController();
  const timeout = config.timeoutMs
    ? setTimeout(() => controller.abort(), config.timeoutMs)
    : undefined;

  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new LlmJudgeProviderError(
        `chat completions request failed with HTTP ${response.status}: ${summarizeProviderError(text)}`,
      );
    }
    return JSON.parse(text) as unknown;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function buildJudgePrompt(
  input: LlmJudgeInput,
  ctx: VerifierContext,
): Promise<string> {
  const resolvedInputs = await Promise.all(
    input.inputs.map((item) => resolveJudgeInput(item, ctx)),
  );
  return [
    "Evaluate the artifact against this rubric.",
    "",
    "Rubric:",
    input.rubric ?? "(rubric was not provided)",
    "",
    `Minimum passing score: ${input.min_score}`,
    "",
    "Inputs:",
    JSON.stringify(resolvedInputs, null, 2),
    "",
    'Return exactly: {"score": <0.0-10.0>, "rationale": "<one paragraph>"}',
  ].join("\n");
}

async function resolveJudgeInput(
  item: unknown,
  ctx: VerifierContext,
): Promise<unknown> {
  if (!isRecord(item) || typeof item.path !== "string") return item;
  const filePath = resolveWorkspacePath(ctx.workspaceDir, item.path);
  const content = await readFile(filePath, "utf8");
  return { ...item, content };
}

function parseJudgeResponse(body: unknown): LlmJudgeResult {
  const content = extractMessageContent(body);
  const result = parseJsonObject(content);
  if (!isRecord(result) || typeof result.score !== "number") {
    throw new LlmJudgeProviderError("judge response JSON must include numeric score");
  }
  if (typeof result.rationale !== "string") {
    throw new LlmJudgeProviderError("judge response JSON must include string rationale");
  }
  return { score: result.score, rationale: result.rationale };
}

function extractMessageContent(response: unknown): string {
  if (!isRecord(response)) {
    throw new LlmJudgeProviderError("judge response must be a JSON object");
  }
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmJudgeProviderError("judge response missing choices[0]");
  }
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new LlmJudgeProviderError("judge response missing choices[0].message");
  }
  const content = first.message.content;
  if (typeof content !== "string") {
    throw new LlmJudgeProviderError("judge response message content must be a string");
  }
  return content;
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = /\{[\s\S]*\}/u.exec(content);
    if (!match) throw new LlmJudgeProviderError("judge response did not contain JSON");
    return JSON.parse(match[0]);
  }
}

function parseProvider(value: string | undefined): OpenAICompatibleProvider | undefined {
  if (!value || value === "none" || value === "disabled") return undefined;
  if (value === "kimi" || value === "openai" || value === "openai-compatible") {
    return value;
  }
  throw new ModelProviderConfigError(
    `unsupported provider ${JSON.stringify(value)}; expected kimi, openai, openai-compatible, none, or disabled`,
  );
}

function summarizeProviderError(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const type = typeof parsed.error.type === "string" ? parsed.error.type : "provider_error";
      const code = typeof parsed.error.code === "string" ? parsed.error.code : undefined;
      return [type, code].filter(Boolean).join(" ");
    }
  } catch {
    // Fall through to redacted text.
  }
  return redactSensitiveText(text).slice(0, 200);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/ak-[A-Za-z0-9_-]+/gu, "ak-[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/gu, "sk-[redacted]")
    .replace(/org-[A-Za-z0-9_-]+/gu, "org-[redacted]")
    .replace(/[A-Za-z0-9_-]{20,}/gu, "[redacted]");
}

function parseThinking(value: string | undefined): ThinkingMode | undefined {
  if (!value) return undefined;
  if (value === "enabled" || value === "true" || value === "1") return "enabled";
  if (value === "disabled" || value === "false" || value === "0") return "disabled";
  throw new ModelProviderConfigError(
    `unsupported thinking mode ${JSON.stringify(value)}; expected enabled or disabled`,
  );
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined;
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new ModelProviderConfigError(
    `unsupported reasoning effort ${JSON.stringify(value)}; expected none, minimal, low, medium, high, or xhigh`,
  );
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new ModelProviderConfigError(
      `expected positive integer timeout, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function defaultFetch(): FetchLike {
  if (!globalThis.fetch) {
    throw new ModelProviderConfigError("global fetch is unavailable");
  }
  return globalThis.fetch as unknown as FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
