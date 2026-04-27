import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Verifier } from "../../directives/schema.js";
import {
  evidenceFromOutput,
  resolveWorkspacePath,
  type VerifierContext,
  type VerifierResult,
} from "./common.js";

const execAsync = promisify(exec);

export async function verifyJsonSchemaMatch(
  verifier: Verifier & { type: "json_schema_match"; path?: string; cmd?: string; schema: unknown },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  let raw: string;
  try {
    if (verifier.path) {
      raw = await readFile(resolveWorkspacePath(ctx.workspaceDir, verifier.path), "utf8");
    } else {
      const { stdout, stderr } = await execAsync(verifier.cmd ?? "", {
        cwd: ctx.workspaceDir,
        timeout: 300_000,
        maxBuffer: 1024 * 1024 * 10,
      });
      if (stderr.trim()) {
        return {
          pass: false,
          detail: "json_schema_match command wrote stderr",
          evidence: evidenceFromOutput(stdout, stderr),
        };
      }
      raw = stdout;
    }
  } catch (error) {
    return {
      pass: false,
      detail: `could not read JSON input: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      pass: false,
      detail: `input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const failure = validateSchema(parsed, verifier.schema, "$");
  return failure
    ? { pass: false, detail: failure }
    : { pass: true, detail: "JSON matches schema" };
}

function validateSchema(
  value: unknown,
  schema: unknown,
  location: string,
): string | undefined {
  if (!isRecord(schema)) return undefined;

  if ("const" in schema && !Object.is(value, schema.const)) {
    return `${location} does not match const`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return `${location} is not in enum`;
  }
  if (typeof schema.type === "string" && jsonType(value) !== schema.type) {
    return `${location} is ${jsonType(value)}, expected ${schema.type}`;
  }
  if (Array.isArray(schema.required)) {
    if (!isRecord(value)) return `${location} is not an object`;
    for (const key of schema.required) {
      if (typeof key === "string" && !(key in value)) {
        return `${location}.${key} is required`;
      }
    }
  }
  if (isRecord(schema.properties)) {
    if (!isRecord(value)) return `${location} is not an object`;
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        const failure = validateSchema(value[key], childSchema, `${location}.${key}`);
        if (failure) return failure;
      }
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateSchema(value[index], schema.items, `${location}[${index}]`);
      if (failure) return failure;
    }
  }
  return undefined;
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

