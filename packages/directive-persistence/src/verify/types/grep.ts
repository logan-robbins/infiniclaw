import { readFile } from "node:fs/promises";
import type { Verifier } from "../../directives/schema.js";
import {
  resolveWorkspacePath,
  type VerifierContext,
  type VerifierResult,
} from "./common.js";

type GrepVerifier = Verifier & {
  type: "grep_present" | "grep_absent";
  path: string;
  pattern: string;
  flags?: string;
};

export async function verifyGrep(
  verifier: GrepVerifier,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  const filePath = resolveWorkspacePath(ctx.workspaceDir, verifier.path);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return { pass: false, detail: `${verifier.path} could not be read` };
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(verifier.pattern, verifier.flags);
  } catch (error) {
    return {
      pass: false,
      detail: `invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const found = pattern.test(content);
  if (verifier.type === "grep_present") {
    return found
      ? { pass: true, detail: `pattern found in ${verifier.path}` }
      : { pass: false, detail: `pattern not found in ${verifier.path}` };
  }

  return found
    ? { pass: false, detail: `forbidden pattern found in ${verifier.path}` }
    : { pass: true, detail: `pattern absent from ${verifier.path}` };
}
