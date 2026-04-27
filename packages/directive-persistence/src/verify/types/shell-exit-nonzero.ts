import type { Verifier } from "../../directives/schema.js";
import type { VerifierContext, VerifierResult } from "./common.js";
import { verifyShell } from "./shell.js";

export async function verifyShellExitNonzero(
  verifier: Verifier & { type: "shell_exit_nonzero"; cmd: string; cwd?: string; timeout_s?: number },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  return verifyShell(verifier, ctx);
}
