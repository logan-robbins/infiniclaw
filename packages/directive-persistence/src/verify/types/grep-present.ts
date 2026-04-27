import type { Verifier } from "../../directives/schema.js";
import type { VerifierContext, VerifierResult } from "./common.js";
import { verifyGrep } from "./grep.js";

export async function verifyGrepPresent(
  verifier: Verifier & { type: "grep_present"; path: string; pattern: string; flags?: string },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  return verifyGrep(verifier, ctx);
}

