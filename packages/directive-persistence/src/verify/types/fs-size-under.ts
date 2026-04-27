import { stat } from "node:fs/promises";
import type { Verifier } from "../../directives/schema.js";
import {
  resolveWorkspacePath,
  type VerifierContext,
  type VerifierResult,
} from "./common.js";

export async function verifyFsSizeUnder(
  verifier: Verifier & { type: "fs_size_under"; path: string; max_bytes: number },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  try {
    const info = await stat(resolveWorkspacePath(ctx.workspaceDir, verifier.path));
    if (info.size < verifier.max_bytes) {
      return {
        pass: true,
        detail: `${verifier.path} is ${info.size} bytes (< ${verifier.max_bytes})`,
      };
    }
    return {
      pass: false,
      detail: `${verifier.path} is ${info.size} bytes (>= ${verifier.max_bytes})`,
    };
  } catch {
    return { pass: false, detail: `${verifier.path} could not be statted` };
  }
}

