import type { Verifier } from "../../directives/schema.js";
import type { VerifierContext, VerifierResult } from "./common.js";

export type RunVerifierFn = (
  verifier: Verifier,
  ctx: VerifierContext,
) => Promise<VerifierResult>;

export async function verifyAllOf(
  verifier: Verifier & { type: "all_of"; checks: Verifier[] },
  ctx: VerifierContext,
  runVerifier: RunVerifierFn,
): Promise<VerifierResult> {
  const failures: string[] = [];
  for (const check of verifier.checks) {
    const result = await runVerifier(check, ctx);
    if (!result.pass) failures.push(result.detail);
  }
  return failures.length === 0
    ? { pass: true, detail: "all child checks passed" }
    : { pass: false, detail: failures.join("; ") };
}

export async function verifyAnyOf(
  verifier: Verifier & { type: "any_of"; checks: Verifier[] },
  ctx: VerifierContext,
  runVerifier: RunVerifierFn,
): Promise<VerifierResult> {
  const failures: string[] = [];
  for (const check of verifier.checks) {
    const result = await runVerifier(check, ctx);
    if (result.pass) return { pass: true, detail: "at least one child check passed" };
    failures.push(result.detail);
  }
  return { pass: false, detail: failures.join("; ") };
}
