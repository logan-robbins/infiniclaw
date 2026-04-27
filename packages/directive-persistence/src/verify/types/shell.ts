import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Verifier } from "../../directives/schema.js";
import {
  evidenceFromOutput,
  resolveWorkspacePath,
  type VerifierContext,
  type VerifierResult,
} from "./common.js";

const execAsync = promisify(exec);

type ShellVerifier = Verifier & {
  type: "shell_exit_zero" | "shell_exit_nonzero";
  cmd: string;
  cwd?: string;
  timeout_s?: number;
};

export async function verifyShell(
  verifier: ShellVerifier,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  const cwd = verifier.cwd
    ? resolveWorkspacePath(ctx.workspaceDir, verifier.cwd)
    : ctx.workspaceDir;
  const timeout = (verifier.timeout_s ?? 300) * 1000;

  try {
    const { stdout, stderr } = await execAsync(verifier.cmd, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 10,
    });
    const evidence = evidenceFromOutput(stdout, stderr);
    if (verifier.type === "shell_exit_zero") {
      return { pass: true, detail: `command exited 0`, evidence };
    }
    return {
      pass: false,
      detail: "command exited 0, expected non-zero",
      evidence,
    };
  } catch (error) {
    const nodeError = error as {
      code?: number | string;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const evidence = evidenceFromOutput(
      nodeError.stdout ?? "",
      nodeError.stderr ?? nodeError.message ?? "",
    );
    const code = nodeError.signal
      ? `signal ${nodeError.signal}`
      : `exit ${String(nodeError.code ?? "unknown")}`;

    if (verifier.type === "shell_exit_nonzero") {
      return { pass: true, detail: `command exited non-zero (${code})`, evidence };
    }
    return { pass: false, detail: `command failed (${code})`, evidence };
  }
}
