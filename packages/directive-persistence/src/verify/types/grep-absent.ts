import type { Verifier } from "../../directives/schema.js";
import type { VerifierContext, VerifierResult } from "./common.js";
import { verifyGrep } from "./grep.js";

export async function verifyGrepAbsent(
  verifier: Verifier & { type: "grep_absent"; path: string; pattern: string; flags?: string },
  ctx: VerifierContext,
): Promise<VerifierResult> {
  return verifyGrep(verifier, ctx);
}

