import { access } from "node:fs/promises";
import type { Verifier } from "../../directives/schema.js";
import {
  resolveWorkspacePath,
  type VerifierContext,
  type VerifierResult,
} from "./common.js";

export async function verifyFileAbsent(
  verifier: Verifier & { type: "file_absent"; path: string },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  const filePath = resolveWorkspacePath(ctx.workspaceDir, verifier.path);
  try {
    await access(filePath);
    return { pass: false, detail: `${verifier.path} exists` };
  } catch {
    return { pass: true, detail: `${verifier.path} is absent` };
  }
}

