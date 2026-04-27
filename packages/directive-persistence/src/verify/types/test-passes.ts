import type { Verifier } from "../../directives/schema.js";
import type { VerifierContext, VerifierResult } from "./common.js";
import { verifyShell } from "./shell.js";

export async function verifyTestPasses(
  verifier: Verifier & { type: "test_passes"; cmd: string; timeout_s?: number },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  return verifyShell({ ...verifier, type: "shell_exit_zero" }, ctx);
}

