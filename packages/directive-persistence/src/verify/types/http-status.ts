import type { Verifier } from "../../directives/schema.js";
import type { VerifierContext, VerifierResult } from "./common.js";

export async function verifyHttpStatus(
  verifier: Verifier & { type: "http_status"; url: string; method?: string; headers?: Record<string, string>; body_json?: unknown; status: number; expect_json?: unknown; timeout_s?: number },
  _ctx: VerifierContext,
): Promise<VerifierResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (verifier.timeout_s ?? 30) * 1000,
  );

  try {
    const response = await fetch(verifier.url, {
      method: verifier.method ?? "GET",
      headers: {
        ...(verifier.body_json === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(verifier.headers ?? {}),
      },
      body:
        verifier.body_json === undefined
          ? undefined
          : JSON.stringify(verifier.body_json),
      signal: controller.signal,
    });

    if (response.status !== verifier.status) {
      return {
        pass: false,
        detail: `HTTP ${response.status}, expected ${verifier.status}`,
        evidence: await safeResponseBody(response),
      };
    }

    if (verifier.expect_json !== undefined) {
      const body = await response.json().catch(() => undefined);
      if (!matchesExpectation(body, verifier.expect_json)) {
        return {
          pass: false,
          detail: "response JSON did not match expectation",
          evidence: JSON.stringify(body).slice(0, 4000),
        };
      }
    }

    return { pass: true, detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      pass: false,
      detail: `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function safeResponseBody(response: Response): Promise<string> {
  return response.text().then(
    (value) => value.slice(0, 4000),
    () => "",
  );
}

function matchesExpectation(actual: unknown, expected: unknown): boolean {
  if (isMatcher(expected)) {
    if ("$eq" in expected) return Object.is(actual, expected.$eq);
    if ("$regex" in expected) {
      return typeof actual === "string" && new RegExp(expected.$regex).test(actual);
    }
  }

  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => matchesExpectation(actual[index], item))
    );
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      matchesExpectation(actual[key], value),
    );
  }

  return Object.is(actual, expected);
}

function isMatcher(
  value: unknown,
): value is { $eq: unknown } | { $regex: string } {
  return (
    isRecord(value) &&
    (("$eq" in value && Object.keys(value).length === 1) ||
      ("$regex" in value &&
        Object.keys(value).length === 1 &&
        typeof value.$regex === "string"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

